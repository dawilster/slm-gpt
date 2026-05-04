import Foundation
import Darwin

/// Read-only probes of host hardware. Used by ModelCatalog to RAM-gate
/// catalog entries (a 7B model is unsafe to even offer on an 8GB Mac).
enum SystemInfo {
    /// Total physical RAM in gigabytes (rounded down). 8 on a base M1
    /// Air, 16/24/32+ on bigger Macs.
    static let totalRAMGB: Int = {
        var size: UInt64 = 0
        var sizeLen = MemoryLayout<UInt64>.size
        let result = sysctlbyname("hw.memsize", &size, &sizeLen, nil, 0)
        guard result == 0, size > 0 else { return 8 }  // safe default
        return Int(size / (1024 * 1024 * 1024))
    }()

    /// Free RAM in megabytes — sampled live, NOT cached. Used for
    /// pre-flight checks (§3.5 strategy #1).
    static func freeRAMMB() -> Int {
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let pageSize = vm_kernel_page_size

        let result = withUnsafeMutablePointer(to: &stats) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { reboundPtr in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, reboundPtr, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        // "Free" in the conservative sense: free + inactive pages. macOS
        // counts inactive as available; treating it that way matches what
        // Activity Monitor calls "available memory."
        let available = UInt64(stats.free_count + stats.inactive_count) * UInt64(pageSize)
        return Int(available / (1024 * 1024))
    }

    /// Free disk space in gigabytes for the user's home volume. Used to
    /// warn before initiating a multi-GB download.
    static func freeDiskGB() -> Int {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        if let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let available = values.volumeAvailableCapacityForImportantUsage {
            return Int(available / (1024 * 1024 * 1024))
        }
        return 0
    }
}
