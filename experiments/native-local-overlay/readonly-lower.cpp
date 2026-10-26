/**
 * Linux 原生 OverlayFS 实验的只读基线层，由 stable-lower-probe.py 手动启动。
 * 接收来源、独占控制目录和挂载点；输出有界计数，不输出源码或宿主配置。
 * 1. Fd、Node、sameVersion 与 key 管理句柄、观察版本及管理目录过滤。
 * 2. Store 只在创建时读取根身份；list 按需固定目录成员，capture 在首次读取
 *    普通文件时保存内容。openSource 用 openat2 限制根内无符号链接解析。
 * 3. verify 检查已观察版本是否过期，report 输出状态；缓存仅在本进程内有效，
 *    私有内容保留在调用方独占目录，不实现发布、崩溃恢复或全目录原子快照。
 * 4. operations 仅提供 FUSE 读取回调，写入、copy-up 和 whiteout 由上层内核
 *    OverlayFS 完成；main 挂载并通过 stdin 接收 metrics/verify/close。
 * 5. 正常 close 卸载并关闭句柄；控制器负责有界等待、异常退出后的卸载检查。
 *    这不是产品后端，尚不支持链接、持久版本清单及产品 Sandbox 生命周期。
 */
#define FUSE_USE_VERSION 31
#include <fuse3/fuse.h>
#include <linux/openat2.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
struct Failure {
    int code;
};

void require(bool condition, int code) {
    if (!condition) {
        throw Failure{code};
    }
}

class Fd {
public:
    explicit Fd(int value) : value_(value) {
        require(value >= 0, errno);
    }

    ~Fd() {
        if (value_ >= 0) {
            ::close(value_);
        }
    }

    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;

    int get() const {
        return value_;
    }

    int release() {
        int result = value_;
        value_ = -1;
        return result;
    }

private:
    int value_;
};

struct Node {
    struct stat info{};
    bool listed = false;
    std::set<std::string> children;
    int data = -1;
};

bool sameVersion(const struct stat& left, const struct stat& right) {
    return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
        left.st_mode == right.st_mode && left.st_size == right.st_size &&
        left.st_uid == right.st_uid && left.st_gid == right.st_gid &&
        left.st_nlink == right.st_nlink &&
        left.st_mtim.tv_sec == right.st_mtim.tv_sec &&
        left.st_mtim.tv_nsec == right.st_mtim.tv_nsec &&
        left.st_ctim.tv_sec == right.st_ctim.tv_sec &&
        left.st_ctim.tv_nsec == right.st_ctim.tv_nsec;
}

std::string key(const char* path) {
    std::string result(path);
    require(!result.empty() && result.front() == '/', EINVAL);
    require(result.size() <= 4096, ENAMETOOLONG);
    std::size_t offset = 1;
    while (offset < result.size()) {
        auto end = result.find('/', offset);
        auto part = result.substr(offset, end - offset);
        require(!part.empty() && part != "." && part != "..", EINVAL);
        require(part != ".git" && part != ".hg" && part != ".svn", ENOENT);
        if (end == std::string::npos) {
            break;
        }
        offset = end + 1;
    }
    return result;
}

class Store {
public:
    Store(const std::string& source, const std::string& control)
        : root_(::open(source.c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)),
          control_(::open(control.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)),
          source_(source) {
        require(::fstat(root_.get(), &nodes_["/"].info) == 0, errno);
    }

    ~Store() {
        for (auto& [_, node] : nodes_) {
            if (node.data >= 0) {
                ::close(node.data);
            }
        }
    }

    std::mutex mutex;

    Node& node(const std::string& name) {
        auto existing = nodes_.find(name);
        if (existing != nodes_.end()) {
            return existing->second;
        }

        require(nodes_.size() < 10000, EFBIG);
        auto slash = name.rfind('/');
        auto parent = slash == 0 ? "/" : name.substr(0, slash);
        auto leaf = name.substr(slash + 1);
        auto& folder = node(parent);
        list(parent, folder);
        require(folder.children.contains(leaf), ENOENT);
        auto handle = openSource(name, O_PATH);
        Node value;
        require(::fstat(handle.get(), &value.info) == 0, errno);
        require(S_ISDIR(value.info.st_mode) || S_ISREG(value.info.st_mode), ENOTSUP);
        return nodes_.emplace(name, std::move(value)).first->second;
    }

    void list(const std::string& name, Node& entry) {
        require(S_ISDIR(entry.info.st_mode), ENOTDIR);
        if (entry.listed) {
            return;
        }

        auto handle = openSource(name, O_RDONLY | O_DIRECTORY);
        struct stat before{};
        require(::fstat(handle.get(), &before) == 0, errno);
        require(sameVersion(before, entry.info), ESTALE);
        DIR* directory = ::fdopendir(handle.get());
        require(directory != nullptr, errno);
        handle.release();
        std::set<std::string> names;
        try {
            enumerations_++;
            for (;;) {
                errno = 0;
                auto item = ::readdir(directory);
                if (!item) {
                    require(errno == 0, errno);
                    break;
                }
                std::string child(item->d_name);
                if (child == "." || child == ".." || child == ".git" ||
                    child == ".hg" || child == ".svn") {
                    continue;
                }
                require(names.size() < 100000, EFBIG);
                names.insert(std::move(child));
            }
            struct stat after{};
            require(::fstat(::dirfd(directory), &after) == 0, errno);
            require(sameVersion(before, after), ESTALE);
        } catch (...) {
            ::closedir(directory);
            throw;
        }
        ::closedir(directory);
        entry.children = std::move(names);
        entry.listed = true;
    }

    void capture(const std::string& name, Node& entry) {
        require(S_ISREG(entry.info.st_mode), EISDIR);
        if (entry.data >= 0) {
            return;
        }
        require(entry.info.st_size >= 0 && entry.info.st_size <= 16 * 1024 * 1024, EFBIG);
        auto source = openSource(name, O_RDONLY);
        struct stat before{};
        require(::fstat(source.get(), &before) == 0, errno);
        require(sameVersion(before, entry.info), ESTALE);
        auto object = "object-" + std::to_string(++objects_);
        Fd destination(::openat(control_.get(), object.c_str(),
            O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
        std::array<char, 65536> buffer;
        off_t position = 0;
        while (position < before.st_size) {
            auto count = ::pread(source.get(), buffer.data(),
                std::min<off_t>(buffer.size(), before.st_size - position), position);
            require(count > 0, count == 0 ? ESTALE : errno);
            ssize_t written = 0;
            while (written < count) {
                auto result = ::pwrite(destination.get(), buffer.data() + written,
                    count - written, position + written);
                require(result > 0, result == 0 ? EIO : errno);
                written += result;
            }
            position += count;
        }
        struct stat after{};
        require(::fstat(source.get(), &after) == 0, errno);
        require(sameVersion(before, after), ESTALE);
        auto current = openSource(name, O_PATH);
        require(::fstat(current.get(), &after) == 0, errno);
        require(sameVersion(before, after), ESTALE);
        require(::fsync(destination.get()) == 0, errno);
        entry.data = destination.release();
        bytes_ += position;
    }

    bool verify() {
        struct stat currentRoot{};
        if (::lstat(source_.c_str(), &currentRoot) != 0 ||
            currentRoot.st_dev != nodes_.at("/").info.st_dev ||
            currentRoot.st_ino != nodes_.at("/").info.st_ino) {
            return false;
        }
        for (const auto& [name, entry] : nodes_) {
            try {
                auto current = openSource(name, O_PATH);
                struct stat info{};
                require(::fstat(current.get(), &info) == 0, errno);
                if (!sameVersion(entry.info, info)) {
                    return false;
                }
            } catch (...) {
                return false;
            }
        }
        return true;
    }

    void report(const std::string& state, bool valid) const {
        std::cout << "{\"state\":\"" << state << "\",\"valid\":"
            << (valid ? "true" : "false") << ",\"nodes\":" << nodes_.size()
            << ",\"objects\":" << objects_ << ",\"copiedBytes\":" << bytes_
            << ",\"sourceOpens\":" << opens_ << ",\"enumerations\":"
            << enumerations_ << "}" << std::endl;
    }

private:
    Fd openSource(const std::string& name, int flags) {
        struct open_how how{};
        how.flags = flags | O_CLOEXEC | O_NOFOLLOW;
        how.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS;
        std::string relative = name == "/" ? "." : name.substr(1);
        opens_++;
        return Fd(static_cast<int>(::syscall(SYS_openat2, root_.get(),
            relative.c_str(), &how, sizeof(how))));
    }

    Fd root_;
    Fd control_;
    std::string source_;
    std::map<std::string, Node> nodes_;
    std::uint64_t opens_ = 0;
    std::uint64_t enumerations_ = 0;
    std::uint64_t objects_ = 0;
    std::uint64_t bytes_ = 0;
};

Store& store() {
    return *static_cast<Store*>(fuse_get_context()->private_data);
}

template<class Action>
int call(Action action) {
    auto& current = store();
    std::lock_guard lock(current.mutex);
    try {
        return action(current);
    } catch (const Failure& failure) {
        return -failure.code;
    } catch (...) {
        return -EIO;
    }
}

fuse_operations operations() {
    fuse_operations result{};
    result.init = [](fuse_conn_info*, fuse_config* config) -> void* {
        config->use_ino = 1;
        config->entry_timeout = 3600;
        config->attr_timeout = 3600;
        config->negative_timeout = 3600;
        return fuse_get_context()->private_data;
    };
    result.getattr = [](const char* path, struct stat* info, fuse_file_info*) {
        return call([&](Store& current) {
            *info = current.node(key(path)).info;
            return 0;
        });
    };
    result.readdir = [](const char* path, void* buffer, fuse_fill_dir_t fill,
                        off_t offset, fuse_file_info*, fuse_readdir_flags) {
        return call([&](Store& current) {
            auto name = key(path);
            auto& entry = current.node(name);
            current.list(name, entry);
            std::vector<std::string> names{".", ".."};
            names.insert(names.end(), entry.children.begin(), entry.children.end());
            require(offset >= 0, EINVAL);
            for (std::size_t index = offset; index < names.size(); index++) {
                if (fill(buffer, names[index].c_str(), nullptr, index + 1,
                    static_cast<fuse_fill_dir_flags>(0))) {
                    break;
                }
            }
            return 0;
        });
    };
    result.open = [](const char* path, fuse_file_info* info) {
        return call([&](Store& current) {
            require((info->flags & O_ACCMODE) == O_RDONLY, EROFS);
            auto name = key(path);
            auto& entry = current.node(name);
            current.capture(name, entry);
            info->fh = static_cast<std::uint64_t>(entry.data);
            info->keep_cache = 1;
            return 0;
        });
    };
    result.read = [](const char*, char* buffer, std::size_t size, off_t offset,
                     fuse_file_info* info) {
        auto count = ::pread(static_cast<int>(info->fh), buffer, size, offset);
        return count < 0 ? -errno : static_cast<int>(count);
    };
    return result;
}
} // namespace

int main(int argc, char** argv) {
    if (argc != 4) {
        std::cerr << "usage: readonly-lower SOURCE EMPTY_CONTROL MOUNT" << std::endl;
        return 2;
    }
    try {
        Store current(argv[1], argv[2]);
        char program[] = "codeatelier-readonly-lower";
        char option[] = "-o";
        char settings[] = "ro,default_permissions,nosuid,nodev";
        char* arguments[] = {program, option, settings};
        fuse_args args = FUSE_ARGS_INIT(3, arguments);
        auto callbacks = operations();
        fuse* filesystem = fuse_new(&args, &callbacks, sizeof(callbacks), &current);
        require(filesystem != nullptr, EIO);
        if (fuse_mount(filesystem, argv[3]) != 0) {
            fuse_destroy(filesystem);
            fuse_opt_free_args(&args);
            throw Failure{EIO};
        }
        current.report("ready", true);
        std::thread control([&]() {
            std::string command;
            while (std::getline(std::cin, command) && command != "close") {
                std::lock_guard lock(current.mutex);
                bool valid = command == "verify" ? current.verify() : true;
                current.report(command == "verify" ? "verified" : "metrics", valid);
            }
            fuse_exit(filesystem);
            fuse_unmount(filesystem);
        });
        int result = fuse_loop(filesystem);
        control.join();
        fuse_destroy(filesystem);
        fuse_opt_free_args(&args);
        return result == 0 ? 0 : 1;
    } catch (const Failure& failure) {
        std::cerr << "LOWER_ERROR errno=" << failure.code << std::endl;
    } catch (...) {
        std::cerr << "LOWER_ERROR unexpected" << std::endl;
    }
    return 1;
}
