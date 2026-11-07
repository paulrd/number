//! `regions-tool` — exporter and signer for the region dataset stage.
//!
//! Implementation of DESIGN-regions-p1.md §6. Two streaming passes over
//! `trie.db` through the `sqlite3` CLI (no native SQLite dependency):
//!
//! 1. paths only, to compute subtree sizes and shard boundaries;
//! 2. quantized rows, to encode shards, params and the manifest payload.
//!
//! Everything is deterministic: the same database, depth, target and blob WASM
//! produce byte-identical shards, payload and signature.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use region_wire as wire;

/// Fixed row prefix: path_len (1) + four i32 bounds (16) + population (4).
const ROW_PREFIX_BYTES: u64 = 21;
/// magic (4) + format version (1) + row_count (4).
const SHARD_HEADER_BYTES: u64 = 9;
/// The design's shard target.
const DEFAULT_TARGET: u64 = 262_144;
const DEFAULT_MAX_DEPTH: usize = 7;
/// Coordinates are stored as `round(degrees * 2^22)`.
const COORD_SCALE: f64 = 4_194_304.0;
const MAX_LON: i32 = 754_974_720; // 180 * 2^22
const MAX_LAT: i32 = 377_487_360; // 90 * 2^22

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = run(&args) {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("export") => export_cli(&args[1..]),
        Some("sign") => sign_cli(&args[1..]),
        Some("publish") => publish_cli(&args[1..]),
        Some("verify") => verify_cli(&args[1..]),
        Some("-h" | "--help") | None => {
            usage();
            Ok(())
        }
        Some(other) => Err(format!("unknown command `{other}` (try --help)")),
    }
}

fn usage() {
    eprintln!(
        "\
regions-tool — region dataset stage 1

  export --db <path> --out <dir> --blob-code-wasm <raw wasm>
         [--max-depth 7] [--target 262144]
         [--expect-rows N] [--expect-row-bytes N] [--expect-shards N]

  sign   --out <dir> [--seq 1] [--key-file <path outside the repo>]
         [--manifest-code-wasm <raw wasm>]
         (or set REGIONS_PUBLISHER_SEED to 64 hex characters)

  publish --out <dir> --port <node ws port> [--workers 3] [--fdev <path>]
          [--dry-run]

  verify  --out <dir> --port <node ws port> [--sample 8 | --all]
          [--fdev <path>]

The code hash is BLAKE3 of the RAW wasm; the packaged file embeds a container
and hashes differently. `export` reads only README paths (a-h) and aborts on
any row that is not quantized exactly."
    );
}

// ---------------------------------------------------------------------------
// CLI

struct ExportOptions {
    db: PathBuf,
    out: PathBuf,
    max_depth: usize,
    target: u64,
    blob_code_wasm: PathBuf,
    expect_rows: Option<u64>,
    expect_row_bytes: Option<u64>,
    expect_shards: Option<usize>,
}

struct SignOptions {
    out: PathBuf,
    seq: u64,
    seed: Option<[u8; 32]>,
    key_file: Option<PathBuf>,
    manifest_code_wasm: Option<PathBuf>,
}

fn export_cli(args: &[String]) -> Result<(), String> {
    let options = ExportOptions {
        db: PathBuf::from(flag(args, "--db").unwrap_or("trie.db")),
        out: PathBuf::from(flag(args, "--out").unwrap_or(".build/regions")),
        max_depth: match flag(args, "--max-depth") {
            Some(value) => value.parse().map_err(|_| "--max-depth must be a number")?,
            None => DEFAULT_MAX_DEPTH,
        },
        target: match flag(args, "--target") {
            Some(value) => value.parse().map_err(|_| "--target must be a number")?,
            None => DEFAULT_TARGET,
        },
        blob_code_wasm: PathBuf::from(
            flag(args, "--blob-code-wasm").unwrap_or(".build/regions/blob.code.wasm"),
        ),
        expect_rows: parse_optional(args, "--expect-rows")?,
        expect_row_bytes: parse_optional(args, "--expect-row-bytes")?,
        expect_shards: parse_optional(args, "--expect-shards")?,
    };
    export(&options)
}

fn sign_cli(args: &[String]) -> Result<(), String> {
    let seed = match std::env::var("REGIONS_PUBLISHER_SEED") {
        Ok(value) => Some(parse_seed(&value)?),
        Err(_) => None,
    };
    let options = SignOptions {
        out: PathBuf::from(flag(args, "--out").unwrap_or(".build/regions")),
        seq: match flag(args, "--seq") {
            Some(value) => value.parse().map_err(|_| "--seq must be a number")?,
            None => 1,
        },
        seed,
        key_file: flag(args, "--key-file").map(PathBuf::from),
        manifest_code_wasm: flag(args, "--manifest-code-wasm").map(PathBuf::from),
    };
    sign(&options)
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|argument| argument == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn parse_optional<T: std::str::FromStr>(args: &[String], name: &str) -> Result<Option<T>, String> {
    match flag(args, name) {
        Some(value) => value
            .parse()
            .map(Some)
            .map_err(|_| format!("{name} has an invalid value")),
        None => Ok(None),
    }
}

fn parse_seed(value: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(value.trim()).map_err(|_| "seed is not hex".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "seed must be exactly 32 bytes (64 hex characters)".to_string())
}

// ---------------------------------------------------------------------------
// Paths and the trie

fn parse_path(text: &str, max_depth: usize) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > max_depth || bytes.len() > 32 {
        return Err(format!(
            "path `{text}` has an invalid length (1..={max_depth})"
        ));
    }
    let mut digits = Vec::with_capacity(bytes.len());
    for &byte in bytes {
        if !(b'a'..=b'h').contains(&byte) {
            return Err(format!("path `{text}` contains a non a-h character"));
        }
        digits.push(byte - b'a');
    }
    Ok(digits)
}

fn path_letters(digits: &[u8]) -> String {
    digits.iter().map(|digit| (b'a' + digit) as char).collect()
}

/// Three bits per digit, most-significant first, zero-padded in the last byte.
fn pack_path(digits: &[u8], out: &mut Vec<u8>) {
    let byte_len = (3 * digits.len()).div_ceil(8);
    let start = out.len();
    out.resize(start + byte_len, 0);
    let mut accumulator: u16 = 0;
    let mut bits: u8 = 0;
    let mut index = 0;
    for &digit in digits {
        accumulator = (accumulator << 3) | u16::from(digit);
        bits += 3;
        if bits >= 8 {
            bits -= 8;
            out[start + index] = (accumulator >> bits) as u8;
            index += 1;
        }
    }
    if bits > 0 {
        out[start + index] = ((accumulator << (8 - bits)) & 0xff) as u8;
    }
}

fn row_bytes(path_len: usize) -> u64 {
    ROW_PREFIX_BYTES + (3 * path_len).div_ceil(8) as u64
}

fn is_prefix(short: &[u8], long: &[u8]) -> bool {
    short.len() <= long.len() && long[..short.len()] == *short
}

struct Tree {
    flat: Vec<u8>,
    offsets: Vec<u32>,
    lens: Vec<u8>,
    /// First index after a node's subtree (preorder).
    next: Vec<usize>,
    /// Prefix sums of row bytes.
    prefix: Vec<u64>,
}

impl Tree {
    fn new(flat: Vec<u8>, offsets: Vec<u32>, lens: Vec<u8>) -> Result<Self, String> {
        let n = lens.len();
        let mut prefix = vec![0u64; n + 1];
        for i in 0..n {
            prefix[i + 1] = prefix[i] + row_bytes(lens[i] as usize);
        }

        let mut next = vec![n; n];
        let mut stack: Vec<usize> = Vec::new();
        for i in 0..n {
            while let Some(&top) = stack.last() {
                if is_prefix(
                    slice(&flat, &offsets, &lens, top),
                    slice(&flat, &offsets, &lens, i),
                ) {
                    break;
                }
                next[stack.pop().expect("stack is non-empty")] = i;
            }
            stack.push(i);
        }
        for top in stack {
            next[top] = n;
        }

        Ok(Self {
            flat,
            offsets,
            lens,
            next,
            prefix,
        })
    }

    fn path(&self, index: usize) -> &[u8] {
        slice(&self.flat, &self.offsets, &self.lens, index)
    }

    fn len(&self) -> usize {
        self.lens.len()
    }

    fn size(&self, start: usize, end: usize) -> u64 {
        self.prefix[end] - self.prefix[start]
    }

    fn boundaries(&self, target: u64) -> Vec<(usize, usize)> {
        let n = self.len();
        if n == 0 {
            return Vec::new();
        }
        let mut units = Vec::new();
        let mut i = 0;
        while i < n {
            let end = self.next[i];
            if self.size(i, end) <= target {
                units.push((i, end));
            } else {
                units.extend(self.pack_subtree(i, target));
            }
            i = end;
        }
        self.bundle(units, target)
    }

    /// [i, next(i)) is larger than the target: keep the node row and pack its
    /// children, never splitting a child that fits.
    fn pack_subtree(&self, i: usize, target: u64) -> Vec<(usize, usize)> {
        let end = self.next[i];
        if self.size(i, end) <= target || i + 1 >= end {
            return vec![(i, end)];
        }
        let mut units = vec![(i, i + 1)];
        let mut child = i + 1;
        while child < end {
            let child_end = self.next[child];
            if self.size(child, child_end) <= target {
                units.push((child, child_end));
            } else {
                units.extend(self.pack_subtree(child, target));
            }
            child = child_end;
        }
        self.bundle(units, target)
    }

    fn bundle(&self, units: Vec<(usize, usize)>, target: u64) -> Vec<(usize, usize)> {
        let mut shards = Vec::new();
        let mut iter = units.into_iter();
        let Some((mut start, mut end)) = iter.next() else {
            return shards;
        };
        for (next_start, next_end) in iter {
            if self.size(start, next_end) <= target {
                end = next_end;
            } else {
                shards.push((start, end));
                start = next_start;
                end = next_end;
            }
        }
        shards.push((start, end));
        shards
    }
}

fn slice<'a>(flat: &'a [u8], offsets: &[u32], lens: &[u8], index: usize) -> &'a [u8] {
    let offset = offsets[index] as usize;
    &flat[offset..offset + lens[index] as usize]
}

type PathIndex = (Vec<u8>, Vec<u32>, Vec<u8>);

fn load_paths(db: &Path, max_depth: usize) -> Result<PathIndex, String> {
    let sql = format!(
        "SELECT materialized_path FROM region \
         WHERE length(materialized_path) <= {max_depth} \
         ORDER BY materialized_path"
    );
    let output = Command::new("sqlite3")
        .arg("-readonly")
        .arg("-csv")
        .arg("-noheader")
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|error| format!("could not run sqlite3: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "sqlite3 failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let text = String::from_utf8(output.stdout).map_err(|_| "sqlite3 output is not UTF-8")?;
    let mut flat = Vec::new();
    let mut offsets = Vec::new();
    let mut lens = Vec::new();
    let mut previous: Option<(usize, usize)> = None;

    for line in text.split('\n') {
        let path = line.trim_end_matches('\r').trim();
        if path.is_empty() {
            continue;
        }
        let digits = parse_path(path, max_depth)?;
        if let Some((offset, len)) = previous {
            if flat[offset..offset + len].cmp(digits.as_slice()) != Ordering::Less {
                return Err(format!("paths are not strictly increasing at `{path}`"));
            }
        }
        offsets.push(flat.len() as u32);
        lens.push(digits.len() as u8);
        previous = Some((flat.len(), digits.len()));
        flat.extend_from_slice(&digits);
    }

    if lens.is_empty() {
        return Err("the database contains no rows at this depth".into());
    }
    Ok((flat, offsets, lens))
}

// ---------------------------------------------------------------------------
// Export

fn export(options: &ExportOptions) -> Result<(), String> {
    let code_hash = blake3_file(&options.blob_code_wasm)?;
    let (flat, offsets, lens) = load_paths(&options.db, options.max_depth)?;
    let tree = Tree::new(flat, offsets, lens)?;
    let boundaries = tree.boundaries(options.target);
    if boundaries.is_empty() {
        return Err("no shards were produced".into());
    }

    let shards_dir = options.out.join("shards");
    let params_dir = options.out.join("params");
    let _ = fs::remove_dir_all(&shards_dir);
    let _ = fs::remove_dir_all(&params_dir);
    fs::create_dir_all(&shards_dir)
        .map_err(|error| format!("could not create shards dir: {error}"))?;
    fs::create_dir_all(&params_dir)
        .map_err(|error| format!("could not create params dir: {error}"))?;

    let sql = format!(
        "SELECT materialized_path, \
                CAST(round(min_lon * {COORD_SCALE:.0}) AS INTEGER), \
                CAST(round(max_lon * {COORD_SCALE:.0}) AS INTEGER), \
                CAST(round(min_lat * {COORD_SCALE:.0}) AS INTEGER), \
                CAST(round(max_lat * {COORD_SCALE:.0}) AS INTEGER), \
                CAST(round(population) AS INTEGER) \
         FROM region WHERE length(materialized_path) <= {} \
         ORDER BY materialized_path",
        options.max_depth
    );

    let mut child = Command::new("sqlite3")
        .arg("-readonly")
        .arg("-csv")
        .arg("-noheader")
        .arg(options.db.as_path())
        .arg(sql)
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run sqlite3: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not read sqlite3 stdout".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let mut entries: Vec<Entry> = Vec::with_capacity(boundaries.len());
    let mut shard_index = 0usize;
    let mut row_index = 0usize;
    let (first_start, first_end) = boundaries[0];
    let mut body = shard_header(first_end - first_start);

    for line in lines.by_ref() {
        let line = line.map_err(|error| format!("could not read sqlite3 output: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let (start, end) = boundaries[shard_index];
        if row_index >= end {
            return Err("more rows than pass 1 saw".into());
        }
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != 6 {
            return Err(format!("malformed row at index {row_index}: {line}"));
        }
        let digits = parse_path(fields[0], options.max_depth)?;
        if digits.as_slice() != tree.path(row_index) {
            return Err(format!(
                "row order changed between passes at index {row_index}"
            ));
        }

        let min_lon = parse_coord(fields[1], true)?;
        let max_lon = parse_coord(fields[2], true)?;
        let min_lat = parse_coord(fields[3], false)?;
        let max_lat = parse_coord(fields[4], false)?;
        if min_lon > max_lon || min_lat > max_lat {
            return Err(format!("inverted bounds at `{}`", fields[0]));
        }
        let population = parse_population(fields[5])?;

        encode_row(
            &digits, min_lon, max_lon, min_lat, max_lat, population, &mut body,
        );
        row_index += 1;

        if row_index == end {
            flush_shard(
                &shards_dir,
                &params_dir,
                shard_index,
                (start, end),
                &tree,
                &body,
                options.target,
                &mut entries,
            )?;
            shard_index += 1;
            if shard_index < boundaries.len() {
                let (next_start, next_end) = boundaries[shard_index];
                body = shard_header(next_end - next_start);
            }
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("sqlite3 did not finish: {error}"))?;
    if !status.success() {
        return Err("sqlite3 failed during the row pass".into());
    }
    if row_index != tree.len() {
        return Err(format!(
            "pass 2 saw {row_index} rows, pass 1 saw {}",
            tree.len()
        ));
    }
    if entries.len() != boundaries.len() {
        return Err("shard count mismatch".into());
    }

    let max_path_len = tree.lens.iter().copied().max().unwrap_or(0);
    let payload = build_payload(&entries, row_index as u64, max_path_len, &code_hash)?;
    fs::write(options.out.join("manifest.payload.bin"), &payload)
        .map_err(|error| format!("could not write the manifest payload: {error}"))?;

    let row_bytes: u64 = tree.prefix[tree.len()];
    let shard_bytes: u64 = entries.iter().map(|entry| u64::from(entry.bytes)).sum();
    write_index(
        options,
        &entries,
        row_index as u64,
        row_bytes,
        shard_bytes,
        max_path_len,
        &code_hash,
    )?;

    if let Some(expected) = options.expect_rows {
        if expected != row_index as u64 {
            return Err(format!("expected {expected} rows, produced {row_index}"));
        }
    }
    if let Some(expected) = options.expect_row_bytes {
        if expected != row_bytes {
            return Err(format!(
                "expected {expected} row bytes, produced {row_bytes}"
            ));
        }
    }
    if let Some(expected) = options.expect_shards {
        if expected != entries.len() {
            return Err(format!(
                "expected {expected} shards, produced {}",
                entries.len()
            ));
        }
    }

    println!("rows:        {row_index}");
    println!("row bytes:   {row_bytes}");
    println!("shard bytes: {shard_bytes}");
    println!("shards:      {}", entries.len());
    println!("max depth:   {max_path_len}");
    println!("blob hash:   {}", bs58::encode(code_hash).into_string());
    Ok(())
}

fn shard_header(rows: usize) -> Vec<u8> {
    let mut body = Vec::with_capacity(SHARD_HEADER_BYTES as usize + rows * 24);
    body.extend_from_slice(b"RGN1");
    body.push(2);
    body.extend_from_slice(&(rows as u32).to_le_bytes());
    body
}

fn parse_coord(field: &str, longitude: bool) -> Result<i32, String> {
    let value: i64 = field
        .parse()
        .map_err(|_| format!("coordinate `{field}` is not an integer"))?;
    let limit = i64::from(if longitude { MAX_LON } else { MAX_LAT });
    if !(-limit..=limit).contains(&value) || value % 4 != 0 {
        return Err(format!(
            "coordinate `{field}` is not a 2^-20 multiple inside the world"
        ));
    }
    Ok(value as i32)
}

fn parse_population(field: &str) -> Result<u32, String> {
    let value: i64 = field
        .parse()
        .map_err(|_| format!("population `{field}` is not an integer"))?;
    u32::try_from(value).map_err(|_| format!("population `{field}` does not fit u32"))
}

fn encode_row(
    digits: &[u8],
    min_lon: i32,
    max_lon: i32,
    min_lat: i32,
    max_lat: i32,
    population: u32,
    out: &mut Vec<u8>,
) {
    out.push(digits.len() as u8);
    pack_path(digits, out);
    out.extend_from_slice(&min_lon.to_le_bytes());
    out.extend_from_slice(&max_lon.to_le_bytes());
    out.extend_from_slice(&min_lat.to_le_bytes());
    out.extend_from_slice(&max_lat.to_le_bytes());
    out.extend_from_slice(&population.to_le_bytes());
}

struct Entry {
    start: Vec<u8>,
    rows: u32,
    bytes: u32,
    hash: [u8; 32],
}

#[allow(clippy::too_many_arguments)]
fn flush_shard(
    shards_dir: &Path,
    params_dir: &Path,
    index: usize,
    (start, end): (usize, usize),
    tree: &Tree,
    body: &[u8],
    target: u64,
    entries: &mut Vec<Entry>,
) -> Result<(), String> {
    if (body.len() as u64).saturating_sub(SHARD_HEADER_BYTES) > target {
        return Err(format!("shard {index} exceeds the target"));
    }
    let name = format!("{index:06}.bin");
    fs::write(shards_dir.join(&name), body)
        .map_err(|error| format!("could not write shard {index}: {error}"))?;
    let hash = *blake3::hash(body).as_bytes();
    let mut params = b"RGB1".to_vec();
    params.extend_from_slice(&hash);
    fs::write(params_dir.join(&name), params)
        .map_err(|error| format!("could not write shard params {index}: {error}"))?;
    entries.push(Entry {
        start: tree.path(start).to_vec(),
        rows: u32::try_from(end - start).map_err(|_| "shard row count overflows u32")?,
        bytes: u32::try_from(body.len()).map_err(|_| "shard size overflows u32")?,
        hash,
    });
    Ok(())
}

fn build_payload(
    entries: &[Entry],
    total_rows: u64,
    max_path_len: u8,
    code_hash: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let shard_count = u32::try_from(entries.len()).map_err(|_| "too many shards")?;
    let mut preimage = b"number:regions:dataset:v1".to_vec();
    preimage.extend_from_slice(&shard_count.to_le_bytes());
    for entry in entries {
        pack_path(&entry.start, &mut preimage);
        preimage.extend_from_slice(&entry.hash);
    }
    let dataset_id = blake3::hash(&preimage);

    let mut payload = Vec::with_capacity(64 + entries.len() * 48);
    payload.extend_from_slice(b"RGM1");
    payload.push(1);
    payload.extend_from_slice(&dataset_id.as_bytes()[..16]);
    payload.push(2); // row format: region-v2
    payload.push(1); // one shard WASM generation
    payload.extend_from_slice(code_hash);
    payload.extend_from_slice(&total_rows.to_le_bytes());
    payload.push(max_path_len);
    payload.extend_from_slice(&shard_count.to_le_bytes());
    for entry in entries {
        payload.push(entry.start.len() as u8);
        pack_path(&entry.start, &mut payload);
        payload.push(0); // code hash id
        payload.extend_from_slice(&entry.rows.to_le_bytes());
        payload.extend_from_slice(&entry.bytes.to_le_bytes());
        payload.extend_from_slice(&entry.hash);
    }
    Ok(payload)
}

fn write_index(
    options: &ExportOptions,
    entries: &[Entry],
    total_rows: u64,
    row_bytes: u64,
    shard_bytes: u64,
    max_path_len: u8,
    code_hash: &[u8; 32],
) -> Result<(), String> {
    let shards: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            serde_json::json!({
                "start": path_letters(&entry.start),
                "rows": entry.rows,
                "bytes": entry.bytes,
                "hash": bs58::encode(entry.hash).into_string(),
            })
        })
        .collect();
    let document = serde_json::json!({
        "format": "region-manifest-v1",
        "row_format": 2,
        "max_depth": options.max_depth,
        "max_path_len": max_path_len,
        "total_rows": total_rows,
        "row_bytes": row_bytes,
        "shard_bytes": shard_bytes,
        "shard_count": entries.len(),
        "blob_code_hash": bs58::encode(code_hash).into_string(),
        "shards": shards,
    });
    let bytes = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("could not encode index.json: {error}"))?;
    fs::write(options.out.join("index.json"), bytes)
        .map_err(|error| format!("could not write index.json: {error}"))
}

fn blake3_file(path: &Path) -> Result<[u8; 32], String> {
    let bytes =
        fs::read(path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    Ok(*blake3::hash(&bytes).as_bytes())
}

// ---------------------------------------------------------------------------
// Sign

fn sign(options: &SignOptions) -> Result<(), String> {
    let payload = fs::read(options.out.join("manifest.payload.bin"))
        .map_err(|error| format!("could not read the manifest payload: {error}"))?;
    let seed = match (&options.seed, &options.key_file) {
        (Some(seed), _) => *seed,
        (None, Some(path)) => load_key_file(path)?,
        (None, None) => {
            return Err("no publisher key: set REGIONS_PUBLISHER_SEED or pass --key-file".into());
        }
    };
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying_key = signing_key.verifying_key();

    let mut params = b"MGB1".to_vec();
    params.extend_from_slice(&verifying_key.to_bytes());
    let namespace = blake3::hash(b"number:regions");
    params.extend_from_slice(&namespace.as_bytes()[..16]);

    let signature = signing_key.sign(&wire::signing_bytes(&params, options.seq, &payload));
    let state = wire::encode_state(options.seq, &payload, &signature.to_bytes())
        .map_err(|error| format!("could not encode the envelope: {error:?}"))?;

    fs::write(options.out.join("manifest.params.bin"), &params)
        .map_err(|error| format!("could not write manifest params: {error}"))?;
    fs::write(options.out.join("manifest.bin"), &state)
        .map_err(|error| format!("could not write the signed manifest: {error}"))?;

    println!("publisher key: {}", hex::encode(verifying_key.to_bytes()));
    println!("seq:           {}", options.seq);
    println!("payload:       {} bytes", payload.len());
    if let Some(wasm) = &options.manifest_code_wasm {
        let code_hash = blake3_file(wasm)?;
        let mut preimage = code_hash.to_vec();
        preimage.extend_from_slice(&params);
        let id = blake3::hash(&preimage);
        println!(
            "manifest id:   {}",
            bs58::encode(id.as_bytes()).into_string()
        );
    }
    Ok(())
}

fn load_key_file(path: &Path) -> Result<[u8; 32], String> {
    if let (Ok(root), Ok(file)) = (fs::canonicalize("."), fs::canonicalize(path)) {
        if file.starts_with(&root) {
            return Err("the key file must live outside the repository".into());
        }
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("could not read the key file: {error}"))?;
    parse_seed(&text)
}

// ---------------------------------------------------------------------------
// Publish and verify

struct PublishOptions {
    out: PathBuf,
    port: u16,
    workers: usize,
    fdev: String,
    dry_run: bool,
}

struct VerifyOptions {
    out: PathBuf,
    port: u16,
    fdev: String,
    sample: usize,
    all: bool,
}

struct ShardJob {
    name: String,
    id: String,
    hash: [u8; 32],
    rows: u32,
}

fn publish_cli(args: &[String]) -> Result<(), String> {
    let port: u16 = flag(args, "--port")
        .ok_or("publish needs --port")?
        .parse()
        .map_err(|_| "--port must be a number")?;
    publish(&PublishOptions {
        out: PathBuf::from(flag(args, "--out").unwrap_or(".build/regions")),
        port,
        workers: match flag(args, "--workers") {
            Some(value) => value.parse().map_err(|_| "--workers must be a number")?,
            None => 3,
        },
        fdev: fdev_path(args),
        dry_run: args.iter().any(|argument| argument == "--dry-run"),
    })
}

fn verify_cli(args: &[String]) -> Result<(), String> {
    let port: u16 = flag(args, "--port")
        .ok_or("verify needs --port")?
        .parse()
        .map_err(|_| "--port must be a number")?;
    verify(&VerifyOptions {
        out: PathBuf::from(flag(args, "--out").unwrap_or(".build/regions")),
        port,
        fdev: fdev_path(args),
        sample: match flag(args, "--sample") {
            Some(value) => value.parse().map_err(|_| "--sample must be a number")?,
            None => 8,
        },
        all: args.iter().any(|argument| argument == "--all"),
    })
}

fn fdev_path(args: &[String]) -> String {
    flag(args, "--fdev")
        .map(str::to_string)
        .or_else(|| std::env::var("FDEV").ok())
        .unwrap_or_else(|| "fdev".to_string())
}

/// Derive every shard's contract id and check the files against their params.
fn collect_jobs(out: &Path) -> Result<Vec<ShardJob>, String> {
    let code_hash = blake3_file(&out.join("blob.code.wasm"))?;
    let index: serde_json::Value = serde_json::from_slice(
        &fs::read(out.join("index.json"))
            .map_err(|error| format!("could not read index.json: {error}"))?,
    )
    .map_err(|error| format!("index.json is not valid JSON: {error}"))?;
    let shards = index["shards"]
        .as_array()
        .ok_or_else(|| "index.json has no shards array".to_string())?;
    let mut jobs = Vec::with_capacity(shards.len());
    for (position, shard) in shards.iter().enumerate() {
        let name = format!("{position:06}.bin");
        let rows = shard["rows"]
            .as_u64()
            .ok_or_else(|| format!("index.json shard {name} has no row count"))?;
        let expected_bytes = shard["bytes"]
            .as_u64()
            .ok_or_else(|| format!("index.json shard {name} has no byte count"))?;
        let state = fs::read(out.join("shards").join(&name))
            .map_err(|error| format!("could not read shard {name}: {error}"))?;
        if state.len() as u64 != expected_bytes {
            return Err(format!("shard {name} does not match its index size"));
        }
        let params = fs::read(out.join("params").join(&name))
            .map_err(|error| format!("could not read params for {name}: {error}"))?;
        if params.len() != 36 || &params[..4] != b"RGB1" {
            return Err(format!("params for {name} are not RGB1 || hash"));
        }
        let hash: [u8; 32] = params[4..]
            .try_into()
            .map_err(|_| format!("params for {name} are truncated"))?;
        if *blake3::hash(&state).as_bytes() != hash {
            return Err(format!("shard {name} does not match its params hash"));
        }
        let mut preimage = code_hash.to_vec();
        preimage.extend_from_slice(&params);
        let id = bs58::encode(blake3::hash(&preimage).as_bytes()).into_string();
        jobs.push(ShardJob {
            name,
            id,
            hash,
            rows: u32::try_from(rows).map_err(|_| "row count overflows u32")?,
        });
    }
    if jobs.is_empty() {
        return Err("no shards to publish".into());
    }
    Ok(jobs)
}

fn publish(options: &PublishOptions) -> Result<(), String> {
    let jobs = collect_jobs(&options.out)?;
    if options.dry_run {
        for job in &jobs {
            println!("shard    {}  {}  ({} rows)", job.name, job.id, job.rows);
        }
        match manifest_id(&options.out)? {
            Some((id, seq)) => println!("manifest {id}  (seq {seq})"),
            None => println!("manifest (not signed)"),
        }
        return Ok(());
    }

    let done = read_ledger(&options.out);
    let pending: Vec<&ShardJob> = jobs.iter().filter(|job| !done.contains(&job.id)).collect();
    println!(
        "{} shards, {} already in the ledger, {} to publish on port {}",
        jobs.len(),
        jobs.len() - pending.len(),
        pending.len(),
        options.port
    );

    let ledger = Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(options.out.join("ledger.jsonl"))
            .map_err(|error| format!("could not open the ledger: {error}"))?,
    );
    let next = AtomicUsize::new(0);
    let failures = Mutex::new(Vec::<String>::new());

    std::thread::scope(|scope| {
        for _ in 0..options.workers.max(1) {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, AtomicOrdering::SeqCst);
                    let Some(&job) = pending.get(index) else {
                        break;
                    };
                    match publish_shard(options, job) {
                        Ok(()) => {
                            record(&ledger, job, "ok", None);
                            println!("ok    {}", job.id);
                        }
                        Err(error) => {
                            record(&ledger, job, "err", Some(&error));
                            println!("FAIL  {}: {error}", job.id);
                            failures.lock().unwrap().push(job.name.clone());
                        }
                    }
                }
            });
        }
    });

    let failures = failures
        .into_inner()
        .unwrap_or_else(|poison| poison.into_inner());
    if !failures.is_empty() {
        return Err(format!(
            "{} shard(s) failed: {}; rerun to resume",
            failures.len(),
            failures.join(", ")
        ));
    }
    publish_manifest(options)
}

fn publish_shard(options: &PublishOptions, job: &ShardJob) -> Result<(), String> {
    let output = Command::new(&options.fdev)
        .arg("--port")
        .arg(options.port.to_string())
        .arg("publish")
        .arg("--code")
        .arg(options.out.join("blob.wasm"))
        .arg("--parameters")
        .arg(options.out.join("params").join(&job.name))
        .arg("contract")
        .arg("--state")
        .arg(options.out.join("shards").join(&job.name))
        .output()
        .map_err(|error| format!("could not run fdev: {error}"))?;
    if !output.status.success() {
        return Err(status_error("publish", &output));
    }

    for attempt in 0..4 {
        match get_contract(&options.fdev, options.port, &job.id) {
            Ok(bytes) if *blake3::hash(&bytes).as_bytes() == job.hash => return Ok(()),
            _ => std::thread::sleep(Duration::from_millis(500 * (attempt + 1))),
        }
    }
    Err("published, but the node did not return the expected state".into())
}

fn publish_manifest(options: &PublishOptions) -> Result<(), String> {
    let Some((id, seq)) = manifest_id(&options.out)? else {
        println!(
            "manifest: no signed manifest in {}; skipped",
            options.out.display()
        );
        return Ok(());
    };
    let state = fs::read(options.out.join("manifest.bin"))
        .map_err(|error| format!("could not read manifest.bin: {error}"))?;
    if let Some(existing) = try_get(&options.fdev, options.port, &id) {
        if existing == state {
            println!("manifest: {id} (seq {seq}) already published");
            return Ok(());
        }
        if seq == 1 {
            return Err("a different manifest already exists at this id".into());
        }
    }

    let mut command = Command::new(&options.fdev);
    command.arg("--port").arg(options.port.to_string());
    if seq == 1 {
        command
            .arg("publish")
            .arg("--code")
            .arg(options.out.join("manifest.wasm"))
            .arg("--parameters")
            .arg(options.out.join("manifest.params.bin"))
            .arg("contract")
            .arg("--state")
            .arg(options.out.join("manifest.bin"));
    } else {
        command
            .arg("execute")
            .arg("update")
            .arg(&id)
            .arg(options.out.join("manifest.bin"))
            .arg("--as-state");
    }
    let output = command
        .output()
        .map_err(|error| format!("could not run fdev: {error}"))?;
    if !output.status.success() {
        return Err(status_error("manifest publish", &output));
    }
    let fetched = get_contract(&options.fdev, options.port, &id)?;
    if fetched != state {
        return Err("manifest GET does not match the signed bytes".into());
    }
    println!("manifest: {id} (seq {seq}) published");
    Ok(())
}

fn verify(options: &VerifyOptions) -> Result<(), String> {
    let jobs = collect_jobs(&options.out)?;
    let selected: Vec<&ShardJob> = if options.all || options.sample == 0 {
        jobs.iter().collect()
    } else {
        let step = jobs.len().div_ceil(options.sample.max(1)).max(1);
        jobs.iter().step_by(step).take(options.sample).collect()
    };

    let mut failures = Vec::new();
    for job in selected {
        match verify_shard(options, job) {
            Ok(()) => println!("ok    {}", job.id),
            Err(error) => {
                println!("FAIL  {}: {error}", job.id);
                failures.push(job.name.clone());
            }
        }
    }

    if let Some((id, seq)) = manifest_id(&options.out)? {
        let expected = fs::read(options.out.join("manifest.bin"))
            .map_err(|error| format!("could not read manifest.bin: {error}"))?;
        match get_contract(&options.fdev, options.port, &id) {
            Ok(bytes) if bytes == expected => println!("ok    manifest {id} (seq {seq})"),
            Ok(_) => {
                println!("FAIL  manifest {id}: bytes differ");
                failures.push("manifest".into());
            }
            Err(error) => {
                println!("FAIL  manifest {id}: {error}");
                failures.push("manifest".into());
            }
        }
    } else {
        println!("manifest: not signed; skipped");
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} check(s) failed: {}",
            failures.len(),
            failures.join(", ")
        ))
    }
}

fn verify_shard(options: &VerifyOptions, job: &ShardJob) -> Result<(), String> {
    let bytes = get_contract(&options.fdev, options.port, &job.id)?;
    if *blake3::hash(&bytes).as_bytes() != job.hash {
        return Err("content hash mismatch".into());
    }
    if bytes.len() < 9 || &bytes[..4] != b"RGN1" || bytes[4] != 2 {
        return Err("bad shard header".into());
    }
    let rows = u32::from_le_bytes(bytes[5..9].try_into().expect("checked length"));
    if rows != job.rows {
        return Err(format!("{rows} rows, index says {}", job.rows));
    }
    Ok(())
}

fn manifest_id(out: &Path) -> Result<Option<(String, u64)>, String> {
    let state_path = out.join("manifest.bin");
    let params_path = out.join("manifest.params.bin");
    if !state_path.exists() || !params_path.exists() {
        return Ok(None);
    }
    let code_hash = blake3_file(&out.join("manifest.code.wasm"))?;
    let params = fs::read(&params_path)
        .map_err(|error| format!("could not read manifest params: {error}"))?;
    let state =
        fs::read(&state_path).map_err(|error| format!("could not read manifest.bin: {error}"))?;
    let seq = wire::decode_state(&state)
        .map_err(|error| format!("signed manifest is invalid: {error:?}"))?
        .seq;
    let mut preimage = code_hash.to_vec();
    preimage.extend_from_slice(&params);
    let id = bs58::encode(blake3::hash(&preimage).as_bytes()).into_string();
    Ok(Some((id, seq)))
}

fn get_contract(fdev: &str, port: u16, id: &str) -> Result<Vec<u8>, String> {
    let path = temp_path(id);
    let _ = fs::remove_file(&path);
    let output = Command::new(fdev)
        .arg("--port")
        .arg(port.to_string())
        .arg("execute")
        .arg("get")
        .arg(id)
        .arg("-o")
        .arg(&path)
        .output()
        .map_err(|error| format!("could not run fdev: {error}"))?;
    let result = if output.status.success() {
        fs::read(&path).map_err(|error| format!("GET produced no file: {error}"))
    } else {
        Err(status_error("get", &output))
    };
    let _ = fs::remove_file(&path);
    result
}

fn try_get(fdev: &str, port: u16, id: &str) -> Option<Vec<u8>> {
    get_contract(fdev, port, id).ok()
}

fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("regions-get-{}-{name}", std::process::id()))
}

fn status_error(what: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let last = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    format!("{what} failed ({}): {}", output.status, last.trim())
}

fn read_ledger(out: &Path) -> HashSet<String> {
    let Ok(text) = fs::read_to_string(out.join("ledger.jsonl")) else {
        return HashSet::new();
    };
    let mut done = HashSet::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value["status"].as_str() == Some("ok") {
            if let Some(id) = value["id"].as_str() {
                done.insert(id.to_string());
            }
        }
    }
    done
}

fn record(ledger: &Mutex<File>, job: &ShardJob, status: &str, error: Option<&str>) {
    let value = serde_json::json!({
        "id": job.id,
        "name": job.name,
        "hash": bs58::encode(job.hash).into_string(),
        "status": status,
        "error": error,
    });
    if let Ok(mut file) = ledger.lock() {
        let _ = writeln!(file, "{value}");
        let _ = file.flush();
    }
}

// ---------------------------------------------------------------------------
// Tests

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_SQL: &str = include_str!("../tests/fixture.sql");

    #[test]
    fn packed_paths_match_the_wire_examples() {
        let mut out = Vec::new();
        pack_path(&[0], &mut out);
        assert_eq!(out, [0x00]);
        out.clear();
        pack_path(&[0, 0], &mut out);
        assert_eq!(out, [0x00]);
        out.clear();
        pack_path(&[0, 1], &mut out);
        assert_eq!(out, [0x04]);
        out.clear();
        pack_path(&[1], &mut out);
        assert_eq!(out, [0x20]);
        out.clear();
        pack_path(&[1, 0], &mut out);
        assert_eq!(out, [0x20]);
    }

    fn tree_from(paths: &[&str]) -> Tree {
        let mut flat = Vec::new();
        let mut offsets = Vec::new();
        let mut lens = Vec::new();
        for path in paths {
            let digits = parse_path(path, 32).expect("valid test path");
            offsets.push(flat.len() as u32);
            lens.push(digits.len() as u8);
            flat.extend_from_slice(&digits);
        }
        Tree::new(flat, offsets, lens).expect("tree")
    }

    #[test]
    fn packer_keeps_subtrees_together_and_bundles_children() {
        // a (aa, ab) b (ba, bb)
        let tree = tree_from(&["a", "aa", "ab", "b", "ba", "bb"]);
        // Every row here is 21 + 1 packed byte.
        assert_eq!(tree.size(0, 6), 132);

        assert_eq!(tree.boundaries(200), vec![(0, 6)]);
        assert_eq!(tree.boundaries(70), vec![(0, 3), (3, 6)]);
        assert_eq!(tree.boundaries(100), vec![(0, 3), (3, 6)]);
        // 60 forces both 66-byte subtrees to split, then rebundle their children.
        let split = tree.boundaries(60);
        assert_eq!(split, vec![(0, 2), (2, 3), (3, 5), (5, 6)]);
        assert_eq!(split.iter().map(|(s, e)| e - s).sum::<usize>(), 6);
    }

    #[test]
    fn path_prefixes_are_respected() {
        let tree = tree_from(&["a", "aa", "ab", "b"]);
        assert_eq!(tree.next[0], 3);
        assert_eq!(tree.next[1], 2);
        assert_eq!(tree.next[2], 3);
        assert_eq!(tree.next[3], 4);
    }

    fn create_fixture_db(path: &Path) {
        let mut child = Command::new("sqlite3")
            .arg(path)
            .stdin(Stdio::piped())
            .spawn()
            .expect("sqlite3 is available");
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(FIXTURE_SQL.as_bytes())
            .expect("write fixture");
        let status = child.wait().expect("sqlite3 wait");
        assert!(status.success(), "fixture database failed");
    }

    #[test]
    fn golden_export_is_stable() {
        let dir = std::env::temp_dir().join(format!("regions-tool-golden-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let db = dir.join("fixture.db");
        create_fixture_db(&db);
        let blob = dir.join("blob.wasm");
        fs::write(&blob, b"fixture-blob").expect("dummy wasm");
        let out = dir.join("out");

        export(&ExportOptions {
            db,
            out: out.clone(),
            max_depth: 2,
            target: 512,
            blob_code_wasm: blob,
            expect_rows: Some(72),
            expect_row_bytes: Some(1584),
            expect_shards: Some(4),
        })
        .expect("export");

        // The publish path derives ids from the raw code hash and re-checks
        // every shard against its params.
        fs::write(out.join("blob.code.wasm"), b"fixture-blob").expect("code wasm");
        fs::write(out.join("blob.wasm"), b"packaged").expect("packaged wasm");
        let jobs = collect_jobs(&out).expect("jobs");
        assert_eq!(jobs.len(), 4);
        assert_eq!(jobs[0].rows, 18);
        assert!(jobs[0].id.len() > 40);

        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/regions");
        assert_eq!(
            fs::read(out.join("manifest.payload.bin")).expect("payload"),
            fs::read(base.join("manifest.bin")).expect("golden manifest")
        );
        assert_eq!(
            fs::read(out.join("shards/000000.bin")).expect("shard"),
            fs::read(base.join("shard.bin")).expect("golden shard")
        );

        let index: serde_json::Value =
            serde_json::from_slice(&fs::read(out.join("index.json")).expect("index"))
                .expect("index json");
        let expected: serde_json::Value =
            serde_json::from_slice(&fs::read(base.join("expected.json")).expect("expected"))
                .expect("expected json");
        assert_eq!(index["total_rows"], expected["total_rows"]);
        assert_eq!(index["shard_count"], expected["shard_count"]);
        assert_eq!(index["row_bytes"], expected["row_bytes"]);
        assert_eq!(index["shard_bytes"], expected["shard_bytes"]);
        assert_eq!(index["max_path_len"], expected["max_path_len"]);
        assert_eq!(index["blob_code_hash"], expected["blob_code_hash"]);
        assert_eq!(index["shards"][0]["start"], expected["start"]);
        assert_eq!(index["shards"][0]["rows"], expected["rows"]);
        assert_eq!(index["shards"][0]["bytes"], expected["bytes"]);
        assert_eq!(index["shards"][0]["hash"], expected["hash"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sign_produces_a_verifiable_envelope() {
        let dir = std::env::temp_dir().join(format!("regions-tool-sign-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let payload = b"manifest payload";
        fs::write(dir.join("manifest.payload.bin"), payload).expect("payload");

        sign(&SignOptions {
            out: dir.clone(),
            seq: 1,
            seed: Some([7u8; 32]),
            key_file: None,
            manifest_code_wasm: None,
        })
        .expect("sign");

        let params = fs::read(dir.join("manifest.params.bin")).expect("params");
        assert_eq!(params.len(), wire::MANIFEST_PARAMS_LEN);
        let state = fs::read(dir.join("manifest.bin")).expect("state");
        let envelope = wire::decode_state(&state).expect("envelope");
        assert_eq!(envelope.seq, 1);
        assert_eq!(envelope.payload, payload.as_slice());

        use ed25519_dalek::{Signature, VerifyingKey};
        let key: [u8; 32] = params[4..36].try_into().expect("key");
        let key = VerifyingKey::from_bytes(&key).expect("valid key");
        let signature = Signature::from_bytes(&envelope.signature);
        key.verify_strict(
            &wire::signing_bytes(&params, envelope.seq, envelope.payload),
            &signature,
        )
        .expect("signature verifies");

        let _ = fs::remove_dir_all(&dir);
    }
}
