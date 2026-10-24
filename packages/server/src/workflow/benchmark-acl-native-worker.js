// Executed only in a bounded benchmark worker, never in the default host.
// Win32 handles use u64, not pointers (pseudo-handles are not virtual addresses).
const { workerData } = require("node:worker_threads")
const { dlopen, toArrayBuffer } = require("bun:ffi")
const header = new Int32Array(workerData.shared, 0, 4)
const output = new Uint8Array(workerData.shared, 16)
const libraries = []
const handles = []
const allocations = []
let result
let status = 2
let kernel

function requireSuccess(value) {
  if (!value) throw Error("Native ACL query failed")
}

function pointer(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw Error("Native ACL pointer")
  return number
}

// Decode only the standard allow/deny ACEs understood by the unchanged policy.
// Unknown ACEs must not disappear from the snapshot.
function sid(bytes, offset, end = bytes.length) {
  if (offset < 0 || offset + 8 > end || bytes[offset] !== 1 || bytes[offset + 1] > 15) throw Error("Native ACL SID")
  const length = 8 + bytes[offset + 1] * 4
  if (offset + length > end) throw Error("Native ACL SID length")
  let authority = 0n
  for (let index = 2; index < 8; index++) authority = (authority << 8n) | BigInt(bytes[offset + index])
  const parts = Array.from({ length: bytes[offset + 1] }, (_, index) => bytes.readUInt32LE(offset + 8 + index * 4))
  return `S-1-${authority}${parts.map((part) => "-" + part).join("")}`
}

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw Error("Native ACL platform")
  kernel = dlopen("C:\\Windows\\System32\\kernel32.dll", {
    GetCurrentProcess: { args: [], returns: "u64" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetFileInformationByHandle: { args: ["u64", "ptr"], returns: "i32" },
    GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    LocalFree: { args: ["ptr"], returns: "ptr" },
  })
  libraries.push(kernel)
  const security = dlopen("C:\\Windows\\System32\\advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    GetSecurityInfo: { args: ["u64", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
    GetSecurityDescriptorLength: { args: ["ptr"], returns: "u32" },
    IsValidSecurityDescriptor: { args: ["ptr"], returns: "i32" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: {
      args: ["ptr", "u32", "u32", "ptr", "ptr"],
      returns: "i32",
    },
  })
  libraries.push(security)
  const target = Buffer.from(workerData.target + "\0", "utf16le")
  // READ_CONTROL | FILE_READ_ATTRIBUTES; OPEN_EXISTING and OPEN_REPARSE_POINT.
  const file = kernel.symbols.CreateFileW(target, 0x20080, 7, null, 3, 0x02200000, 0n)
  if (file === 0xffffffffffffffffn || file === 0n) throw Error("Native ACL open")
  handles.push(file)
  const info = Buffer.alloc(52)
  requireSuccess(kernel.symbols.GetFileInformationByHandle(file, info))
  if (!(info.readUInt32LE(0) & 0x10)) throw Error("Native ACL not a directory")
  const canonical = Buffer.alloc(65536)
  const characters = kernel.symbols.GetFinalPathNameByHandleW(file, canonical, canonical.length / 2, 0)
  if (!characters || characters >= canonical.length / 2) throw Error("Native ACL canonical path")
  if (canonical.subarray(0, characters * 2).toString("utf16le") !== "\\\\?\\" + workerData.target)
    throw Error("Native ACL target changed")

  const token = new BigUint64Array(1)
  requireSuccess(security.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, token))
  handles.push(token[0])
  function tokenInfo(kind) {
    const required = new Uint32Array(1)
    security.symbols.GetTokenInformation(token[0], kind, null, 0, required)
    if (!required[0] || required[0] > 1048576) throw Error("Native ACL token size")
    const bytes = Buffer.alloc(required[0])
    requireSuccess(security.symbols.GetTokenInformation(token[0], kind, bytes, bytes.length, required))
    if (required[0] > bytes.length) throw Error("Native ACL token changed")
    return bytes
  }
  function pointedSid(bytes, offset) {
    const address = pointer(bytes.readBigUInt64LE(offset))
    const prefix = Buffer.from(toArrayBuffer(address, 0, 8))
    if (prefix[0] !== 1 || prefix[1] > 15) throw Error("Native ACL token SID")
    return sid(Buffer.from(toArrayBuffer(address, 0, 8 + prefix[1] * 4)), 0)
  }
  const user = tokenInfo(1)
  const currentUserSid = pointedSid(user, 0)
  const groups = tokenInfo(2)
  const count = groups.readUInt32LE(0)
  if (count > 65536 || 8 + count * 16 > groups.length) throw Error("Native ACL token groups")
  const currentIdentitySids = [currentUserSid, "S-1-1-0"]
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * 16
    // Match WindowsIdentity.Groups: enabled, not deny-only, not logon-ID.
    if ((groups.readUInt32LE(offset + 8) & 0xc0000014) === 4) currentIdentitySids.push(pointedSid(groups, offset))
  }
  const descriptor = new BigUint64Array(1)
  requireSuccess(security.symbols.GetSecurityInfo(file, 1, 7, null, null, null, null, descriptor) === 0)
  const descriptorPointer = pointer(descriptor[0])
  allocations.push(descriptorPointer)
  requireSuccess(security.symbols.IsValidSecurityDescriptor(descriptorPointer))
  const size = security.symbols.GetSecurityDescriptorLength(descriptorPointer)
  if (size < 20 || size > 1048576) throw Error("Native ACL descriptor length")
  const bytes = Buffer.from(toArrayBuffer(descriptorPointer, 0, size))
  const control = bytes.readUInt16LE(2)
  if (bytes[0] !== 1 || !(control & 0x8000) || !(control & 4)) throw Error("Native ACL descriptor")
  const ownerSid = sid(bytes, bytes.readUInt32LE(4))
  const acl = bytes.readUInt32LE(16)
  if (acl < 20 || acl + 8 > bytes.length || ![2, 4].includes(bytes[acl])) throw Error("Native ACL DACL")
  const aclEnd = acl + bytes.readUInt16LE(acl + 2)
  if (aclEnd > bytes.length || aclEnd < acl + 8) throw Error("Native ACL DACL length")
  const aces = []
  let offset = acl + 8
  for (let index = 0; index < bytes.readUInt16LE(acl + 4); index++) {
    if (offset + 8 > aclEnd) throw Error("Native ACL ACE")
    const end = offset + bytes.readUInt16LE(offset + 2)
    if (end > aclEnd || end < offset + 16 || ![0, 1].includes(bytes[offset])) throw Error("Native ACL unsupported ACE")
    aces.push({
      sid: sid(bytes, offset + 8, end),
      allow: bytes[offset] === 0,
      inherited: (bytes[offset + 1] & 0x10) !== 0,
      mask: bytes.readInt32LE(offset + 4),
    })
    offset = end
  }
  const sddl = new BigUint64Array(1)
  const sddlLength = new Uint32Array(1)
  requireSuccess(
    security.symbols.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptorPointer, 1, 7, sddl, sddlLength),
  )
  const sddlPointer = pointer(sddl[0])
  allocations.push(sddlPointer)
  if (!sddlLength[0] || sddlLength[0] > 65537) throw Error("Native ACL SDDL length")
  const text = Buffer.from(toArrayBuffer(sddlPointer, 0, sddlLength[0] * 2)).toString("utf16le")
  // The API reports allocated WCHARs, not the logical string length.
  const terminator = text.indexOf("\0")
  if (terminator < 1) throw Error("Native ACL SDDL terminator")
  result = {
    currentUserSid,
    currentIdentitySids: [...new Set(currentIdentitySids)],
    ownerSid,
    protected: (control & 0x1000) !== 0,
    reparsePoint: (info.readUInt32LE(0) & 0x400) !== 0,
    descriptorSddl: text.slice(0, terminator),
    aces,
  }
  status = 1
} catch {
  result = undefined
} finally {
  try {
    // Publish completion only AFTER releasing every native resource.
    for (const address of allocations.reverse()) requireSuccess(kernel.symbols.LocalFree(address) === null)
    for (const handle of handles.reverse()) requireSuccess(kernel.symbols.CloseHandle(handle))
    for (const library of libraries.reverse()) library.close()
  } catch {
    status = 3
    result = undefined
  }
  const bytes = new TextEncoder().encode(JSON.stringify(result ?? null))
  if (bytes.length > output.length) status = 2
  else {
    output.set(bytes)
    Atomics.store(header, 1, bytes.length)
  }
  Atomics.store(header, 0, status)
  Atomics.notify(header, 0)
}
