import Foundation
import Security
let args = CommandLine.arguments
guard args.count == 4 else { exit(2) }
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: args[2], kSecAttrAccount as String: args[3]]
if args[1] == "set" {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count > 0 else { exit(2) }
    let attributes: [String: Any] = [kSecValueData as String: data]
    let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updated == errSecItemNotFound {
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        exit(SecItemAdd(insert as CFDictionary, nil) == errSecSuccess ? 0 : 1)
    }
    exit(updated == errSecSuccess ? 0 : 1)
} else if args[1] == "get" {
    var read = query
    read[kSecReturnData as String] = true
    read[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { exit(1) }
    FileHandle.standardOutput.write(data)
} else { exit(2) }
