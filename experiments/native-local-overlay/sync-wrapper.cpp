/**
 * Linux lower 手动持久化回归的链接包装器，仅随测试 helper 编译，不进入产品产物。
 * 1. identify 与 record 识别控制目录内的对象/清单/目录，记录调用种类、耗时和结果。
 * 2. __wrap_fsync 默认调用真实 fsync；sync-fail 哨兵让对象同步返回 EIO，验证冻结失败。
 * 3. __wrap_sync_file_range 另验证写回不支持时仍 fsync、真正 I/O 错误则拒绝 seal。
 * 调用方显式链接这两个 --wrap；不记录源码、不拦截产品服务、系统库或其它进程。
 */
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <string>

extern "C" int __real_fsync(int descriptor);
extern "C" int __real_sync_file_range(int descriptor, off64_t offset, off64_t bytes, unsigned int flags);

struct Target {
    std::string control;
    std::string kind;
};

Target identify(int descriptor) {
    std::array<char, 4096> buffer{};
    auto handle = "/proc/self/fd/" + std::to_string(descriptor);
    auto count = ::readlink(handle.c_str(), buffer.data(), buffer.size());
    struct stat info{};
    if (count <= 0 || count == static_cast<ssize_t>(buffer.size()) || ::fstat(descriptor, &info) != 0) {
        return {};
    }

    std::string file(buffer.data(), count);
    auto parent = file.substr(0, file.find_last_of('/'));
    auto name = file.substr(file.find_last_of('/') + 1);
    std::string kind = S_ISDIR(info.st_mode) ? "directory" :
        name.starts_with("object-") ? "object" : "manifest";
    return {S_ISDIR(info.st_mode) ? file : parent, kind};
}

void record(const Target& target, std::chrono::steady_clock::time_point started, int result) {
    int savedError = errno;
    auto micros = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - started).count();
    auto line = target.kind + " " + std::to_string(micros) + " " + std::to_string(result) + "\n";
    int log = ::open((target.control + "/sync-events").c_str(), O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
    if (log >= 0) {
        auto ignored = ::write(log, line.data(), line.size());
        static_cast<void>(ignored);
        ::close(log);
    }

    errno = savedError;
}

extern "C" int __wrap_fsync(int descriptor) {
    auto target = identify(descriptor);
    if (target.control.empty()) {
        return __real_fsync(descriptor);
    }

    auto started = std::chrono::steady_clock::now();
    int result;
    if (target.kind == "object" && ::access((target.control + "/sync-fail").c_str(), F_OK) == 0) {
        errno = EIO;
        result = -1;
    } else {
        result = __real_fsync(descriptor);
    }

    record(target, started, result);
    return result;
}

extern "C" int __wrap_sync_file_range(int descriptor, off64_t offset, off64_t bytes, unsigned int flags) {
    auto target = identify(descriptor);
    if (target.control.empty()) {
        return __real_sync_file_range(descriptor, offset, bytes, flags);
    }

    target.kind = "writeback";
    auto started = std::chrono::steady_clock::now();
    int result;
    if (::access((target.control + "/writeback-unsupported").c_str(), F_OK) == 0) {
        errno = EOPNOTSUPP;
        result = -1;
    } else if (::access((target.control + "/writeback-fail").c_str(), F_OK) == 0) {
        errno = EIO;
        result = -1;
    } else {
        result = __real_sync_file_range(descriptor, offset, bytes, flags);
    }

    record(target, started, result);
    return result;
}
