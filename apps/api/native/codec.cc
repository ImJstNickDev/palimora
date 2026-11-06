// Palimora's bounded batch codec. N-API keeps input buffers alive until
// completion; libuv threads reuse independent Zstd contexts, never a shared
// mutable context.
#include <cmath>
#include <memory>
#include <node_api.h>
#include <stdexcept>
#include <string>
#include <vector>
#include <zdict.h>
#include <zstd.h>
struct Context {
  ZSTD_CCtx *encoder = ZSTD_createCCtx();
  ZSTD_DCtx *decoder = ZSTD_createDCtx();
  ~Context() {
    ZSTD_freeCCtx(encoder);
    ZSTD_freeDCtx(decoder);
  }
};
struct Job {
  napi_async_work work{};
  napi_deferred promise{};
  napi_ref inputs{};
  napi_ref dictionaryRef{};
  void *dictionary = nullptr;
  size_t dictionarySize = 0;
  bool training = false;
  size_t capacity = 0;
  bool decode = false;
  int level = 3;
  std::vector<std::pair<void *, size_t>> input;
  std::vector<size_t> sizes;
  std::vector<std::vector<unsigned char>> output;
  std::string error;
};
static void check(napi_status status) {
  if (status != napi_ok)
    throw std::runtime_error("CODEC_ARGUMENT");
}
static void execute(napi_env, void *opaque) {
  auto *j = static_cast<Job *>(opaque);
  try {
    thread_local Context context;
    if (!context.encoder || !context.decoder)
      throw std::runtime_error("CODEC_MEMORY");
    if (j->training) {
      std::vector<unsigned char> samples;
      std::vector<size_t> sizes;
      for (auto &input : j->input) {
        auto *p = static_cast<unsigned char *>(input.first);
        samples.insert(samples.end(), p, p + input.second);
        sizes.push_back(input.second);
      }
      std::vector<unsigned char> result(j->capacity);
      size_t size =
          ZDICT_trainFromBuffer(result.data(), result.size(), samples.data(),
                                sizes.data(), sizes.size());
      // Too few independent patterns is a valid reason to use ordinary Zstd.
      if (!ZDICT_isError(size)) {
        result.resize(size);
        j->output.push_back(std::move(result));
      }
      return;
    }
    if (j->dictionary) {
      size_t code =
          j->decode ? ZSTD_DCtx_loadDictionary(context.decoder, j->dictionary,
                                               j->dictionarySize)
                    : ZSTD_CCtx_loadDictionary(context.encoder, j->dictionary,
                                               j->dictionarySize);
      if (ZSTD_isError(code))
        throw std::runtime_error(ZSTD_getErrorName(code));
      if (!j->decode) {
        code = ZSTD_CCtx_setParameter(context.encoder, ZSTD_c_compressionLevel,
                                      j->level);
        if (ZSTD_isError(code))
          throw std::runtime_error(ZSTD_getErrorName(code));
      }
    } else {
      size_t code = j->decode
                        ? ZSTD_DCtx_reset(context.decoder,
                                          ZSTD_reset_session_and_parameters)
                        : ZSTD_CCtx_reset(context.encoder,
                                          ZSTD_reset_session_and_parameters);
      if (ZSTD_isError(code))
        throw std::runtime_error(ZSTD_getErrorName(code));
    }
    j->output.reserve(j->input.size());
    for (size_t i = 0; i < j->input.size(); i++) {
      const auto &input = j->input[i];
      j->output.emplace_back(j->decode ? j->sizes[i]
                                       : ZSTD_compressBound(input.second));
      auto &out = j->output.back();
      size_t size =
          j->decode
              ? ZSTD_decompressDCtx(context.decoder, out.data(), out.size(),
                                    input.first, input.second)
              : (j->dictionary
                     ? ZSTD_compress2(context.encoder, out.data(), out.size(),
                                      input.first, input.second)
                     : ZSTD_compressCCtx(context.encoder, out.data(),
                                         out.size(), input.first, input.second,
                                         j->level));
      if (ZSTD_isError(size))
        throw std::runtime_error(ZSTD_getErrorName(size));
      if (j->decode && size != out.size())
        throw std::runtime_error("CODEC_SIZE");
      out.resize(size);
    }
  } catch (const std::exception &e) {
    j->error = e.what();
  }
}
static void release(napi_env, void *, void *hint) {
  delete static_cast<std::vector<unsigned char> *>(hint);
}
static void complete(napi_env env, napi_status status, void *opaque) {
  std::unique_ptr<Job> j(static_cast<Job *>(opaque));
  try {
    if (status != napi_ok)
      throw std::runtime_error("CODEC_CANCELLED");
    if (!j->error.empty())
      throw std::runtime_error(j->error);
    napi_value output;
    check(napi_create_array_with_length(env, j->output.size(), &output));
    for (size_t i = 0; i < j->output.size(); i++) {
      auto *bytes = new std::vector<unsigned char>(std::move(j->output[i]));
      napi_value buffer;
      auto result = napi_create_external_buffer(
          env, bytes->size(), bytes->data(), release, bytes, &buffer);
      if (result != napi_ok) {
        delete bytes;
        check(result);
      }
      check(napi_set_element(env, output, i, buffer));
    }
    check(napi_resolve_deferred(env, j->promise, output));
  } catch (const std::exception &e) {
    napi_value message, error;
    napi_create_string_utf8(env, e.what(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, j->promise, error);
  }
  if (j->dictionaryRef)
    napi_delete_reference(env, j->dictionaryRef);
  napi_delete_reference(env, j->inputs);
  napi_delete_async_work(env, j->work);
}
static napi_value batch(napi_env env, napi_callback_info info) {
  auto j = std::make_unique<Job>();
  try {
    size_t argc = 4;
    napi_value args[4];
    void *mode = nullptr;
    check(napi_get_cb_info(env, info, &argc, args, nullptr, &mode));
    j->training = mode != nullptr;
    if ((j->training && argc != 2) || (!j->training && argc != 3 && argc != 4))
      throw std::runtime_error("CODEC_ARGUMENT");
    if (!j->training)
      check(napi_get_value_bool(env, args[2], &j->decode));
    bool array = false;
    check(napi_is_array(env, args[0], &array));
    if (!array)
      throw std::runtime_error("CODEC_ARGUMENT");
    uint32_t length;
    check(napi_get_array_length(env, args[0], &length));
    if (length > 256)
      throw std::runtime_error("CODEC_BATCH_SIZE");
    if (j->training) {
      uint32_t capacity;
      check(napi_get_value_uint32(env, args[1], &capacity));
      if (capacity < 256 || capacity > 65536)
        throw std::runtime_error("DICTIONARY_SIZE");
      j->capacity = capacity;
    } else if (j->decode) {
      check(napi_is_array(env, args[1], &array));
      if (!array)
        throw std::runtime_error("CODEC_ARGUMENT");
      uint32_t count;
      check(napi_get_array_length(env, args[1], &count));
      if (count != length)
        throw std::runtime_error("CODEC_ARGUMENT");
    } else {
      check(napi_get_value_int32(env, args[1], &j->level));
      if (j->level < 1 || j->level > 19)
        throw std::runtime_error("CODEC_LEVEL");
    }
    if (argc == 4) {
      bool buffer;
      check(napi_is_buffer(env, args[3], &buffer));
      if (!buffer)
        throw std::runtime_error("CODEC_ARGUMENT");
      check(napi_get_buffer_info(env, args[3], &j->dictionary,
                                 &j->dictionarySize));
      if (j->dictionarySize > 65536)
        throw std::runtime_error("DICTIONARY_SIZE");
      check(napi_create_reference(env, args[3], 1, &j->dictionaryRef));
    }
    for (uint32_t i = 0; i < length; i++) {
      napi_value value;
      check(napi_get_element(env, args[0], i, &value));
      bool buffer = false;
      check(napi_is_buffer(env, value, &buffer));
      if (!buffer)
        throw std::runtime_error("CODEC_ARGUMENT");
      void *data;
      size_t size;
      check(napi_get_buffer_info(env, value, &data, &size));
      j->input.emplace_back(data, size);
      if (j->decode) {
        check(napi_get_element(env, args[1], i, &value));
        double n;
        check(napi_get_value_double(env, value, &n));
        if (!std::isfinite(n) || n < 0 || n > 2147483647 || std::floor(n) != n)
          throw std::runtime_error("CODEC_SIZE");
        j->sizes.push_back(static_cast<size_t>(n));
      }
    }
    if (j->training) {
      size_t total = 0;
      for (auto &p : j->input) {
        total += p.second;
        if (total > 8 * 1024 * 1024)
          throw std::runtime_error("DICTIONARY_SAMPLES_SIZE");
      }
    }
    napi_value promise, name;
    check(napi_create_promise(env, &j->promise, &promise));
    check(napi_create_reference(env, args[0], 1, &j->inputs));
    check(
        napi_create_string_utf8(env, "palimora:zstd", NAPI_AUTO_LENGTH, &name));
    check(napi_create_async_work(env, nullptr, name, execute, complete, j.get(),
                                 &j->work));
    check(napi_queue_async_work(env, j->work));
    j.release();
    return promise;
  } catch (const std::exception &e) {
    if (j->work)
      napi_delete_async_work(env, j->work);
    if (j->inputs)
      napi_delete_reference(env, j->inputs);
    if (j->dictionaryRef)
      napi_delete_reference(env, j->dictionaryRef);
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}
napi_value initCatalog(napi_env, napi_value);
static napi_value init(napi_env env, napi_value exports) {
  initCatalog(env, exports);
  napi_value fn;
  napi_create_function(env, "batch", NAPI_AUTO_LENGTH, batch, nullptr, &fn);
  napi_set_named_property(env, exports, "batch", fn);
  napi_create_function(env, "train", NAPI_AUTO_LENGTH, batch,
                       reinterpret_cast<void *>(1), &fn);
  napi_set_named_property(env, exports, "train", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
