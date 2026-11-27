//! One command's declaration-file lexical transitions. All positions index the receiving
//! scanner's own text. Tokens with diagnostics, directives, or computed values use the scanner.
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tsrs_ast::{Kind, SourceFileParseOptions, TokenFlags};
use tsrs_core::{ScriptKind, tspath};

const WIDTH: usize = 12;
const MAX_BYTES: usize = 4 << 20;

pub enum Tape {
    Record { key: [u8; 32], bytes: Vec<u8>, last: Option<u32>, min_span: u32 },
    Replay { bytes: Vec<u8>, next: usize },
}

fn socket() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| std::env::var_os("TSRS_BATCH_SOCKET").map(PathBuf::from)).as_ref()
}

fn connect() -> Option<UnixStream> {
    use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType, socket_with};
    let address = SocketAddrUnix::new(socket()?).ok()?;
    let fd = socket_with(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::NONBLOCK | SocketFlags::CLOEXEC,
        None,
    )
    .ok()?;
    rustix::net::connect(&fd, &address).ok()?;
    let stream = UnixStream::from(fd);
    stream.set_nonblocking(false).ok()?;
    let timeout = Some(Duration::from_secs(2));
    stream.set_read_timeout(timeout).ok()?;
    stream.set_write_timeout(timeout).ok()?;
    Some(stream)
}

// /proc/self/exe identifies the mapped executable even if its pathname was replaced.
// A mixed-version workspace can run several compilers beneath a single task runner.
fn compiler_digest() -> Option<&'static [u8; 32]> {
    static ID: OnceLock<Option<[u8; 32]>> = OnceLock::new();
    ID.get_or_init(|| {
        let mut binary = std::fs::File::open("/proc/self/exe").ok()?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 64 * 1024];
        loop {
            let count = binary.read(&mut buffer).ok()?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        Some(hash.finalize().into())
    })
    .as_ref()
}

pub fn open(opts: &SourceFileParseOptions, kind: ScriptKind, text: &str) -> Option<Tape> {
    socket()?;
    if !(32768..=4 << 20).contains(&text.len())
        || !tspath::is_declaration_file_name(&opts.file_name)
    {
        return None;
    }
    let SourceFileParseOptions { file_name, path, external_module_indicator_options } = opts;
    let mut hash = Sha256::new();
    hash.update(compiler_digest()?);
    for field in [file_name.as_bytes(), path.0.as_bytes()] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    let tsrs_ast::ExternalModuleIndicatorOptions { jsx, force } =
        *external_module_indicator_options;
    hash.update([kind as u8, u8::from(jsx), u8::from(force)]);
    hash.update(text.as_bytes());
    let key: [u8; 32] = hash.finalize().into();
    let mut stream = connect()?;
    stream.write_all(b"G").ok()?;
    stream.write_all(&key).ok()?;
    let mut size = [0; 4];
    stream.read_exact(&mut size).ok()?;
    let size = u32::from_le_bytes(size);
    if size == u32::MAX {
        return Some(Tape::Record {
            key,
            bytes: Vec::new(),
            last: None,
            min_span: if std::env::var_os("TSRS_BATCH_SPARSE").is_some() { 64 } else { 0 },
        });
    }
    let size = size as usize;
    if size == 0 || size > MAX_BYTES || !size.is_multiple_of(WIDTH) {
        return None;
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).ok()?;
    Some(Tape::Replay { bytes, next: 0 })
}

impl Tape {
    pub(crate) fn publish(self) -> Option<()> {
        let Self::Record { key, bytes, .. } = self else { return None };
        if bytes.is_empty() {
            return None;
        }
        let mut stream = connect()?;
        stream.write_all(b"P").ok()?;
        stream.write_all(&key).ok()?;
        stream.write_all(&(bytes.len() as u32).to_le_bytes()).ok()?;
        stream.write_all(&bytes).ok()
    }

    pub(crate) fn add(&mut self, pos: u32, start: u32, end: u32, kind: Kind, flags: TokenFlags) {
        let Self::Record { bytes, last, min_span, .. } = self else { return };
        if end - pos < *min_span
            || last.is_some_and(|p| p >= pos)
            || bytes.len() + WIDTH > MAX_BYTES
        {
            return;
        }
        let (Ok(lead), Ok(width)) = (u16::try_from(start - pos), u8::try_from(end - start)) else {
            return;
        };
        bytes.extend_from_slice(&pos.to_le_bytes());
        bytes.extend_from_slice(&lead.to_le_bytes());
        bytes.push(width);
        bytes.push(kind as u8);
        bytes.extend_from_slice(&flags.bits().to_le_bytes());
        *last = Some(pos);
    }

    pub(crate) fn lookup(&mut self, pos: u32) -> Option<(u32, u32, Kind, TokenFlags)> {
        let Self::Replay { bytes, next } = self else { return None };
        let (rows, _) = bytes.as_chunks::<WIDTH>();
        let position = |row: &[u8; WIDTH]| u32::from_le_bytes(row[..4].try_into().unwrap());
        if rows.get(*next).is_none_or(|row| position(row) != pos) {
            // A skipped literal usually precedes the next entry; rewinds are less common.
            if (*next == 0 || position(&rows[*next - 1]) < pos)
                && rows.get(*next).is_none_or(|row| position(row) > pos)
            {
                return None;
            }
            *next = rows.partition_point(|row| position(row) < pos);
        }
        let row = rows.get(*next)?;
        if position(row) != pos {
            return None;
        }
        *next += 1;
        let start = pos.checked_add(u32::from(u16::from_le_bytes([row[4], row[5]])))?;
        let end = start.checked_add(u32::from(row[6]))?;
        let k = i16::from(row[7]);
        if !(Kind::OpenBraceToken as i16..=Kind::LAST_KEYWORD as i16).contains(&k) {
            return None;
        }
        let kind = Kind::from_i16(k);
        let flags = TokenFlags::from_bits(u32::from_le_bytes(row[8..12].try_into().unwrap()))?;
        Some((start, end, kind, flags))
    }
}
