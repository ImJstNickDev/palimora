// Native preparation of JSON-domain archive documents and PostgreSQL binary
// COPY. Scalar lexemes come from JSON.stringify: preserve ECMAScript number
// spelling, escaping and lone-surrogate representation while sorting keys as
// UTF-16.
#include <algorithm>
#include <charconv>
#include <cstdint>
#include <limits>
#include <memory>
#include <node_api.h>
#include <openssl/sha.h>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>
namespace {
void check(napi_status s) {
  if (s != napi_ok)
    throw std::runtime_error("CATALOG_ARGUMENT");
}
struct Node {
  char type = 0;
  std::string_view raw;
  std::u16string key;
  std::string_view keyRaw;
  std::vector<Node> children;
  const Node *get(std::u16string_view k) const {
    for (auto &n : children)
      if (n.key == k)
        return &n;
    return nullptr;
  }
};
unsigned hex(char c) {
  if (c >= '0' && c <= '9')
    return c - '0';
  if (c >= 'a' && c <= 'f')
    return c - 'a' + 10;
  if (c >= 'A' && c <= 'F')
    return c - 'A' + 10;
  throw std::runtime_error("CATALOG_JSON_ESCAPE");
}
std::u16string decode(std::string_view s) {
  std::u16string out;
  for (size_t i = 1; i + 1 < s.size();) {
    uint32_t c = static_cast<unsigned char>(s[i++]);
    if (c == '\\') {
      if (i >= s.size() - 1)
        throw std::runtime_error("CATALOG_JSON_STRING");
      c = s[i++];
      switch (c) {
      case 'b':
        c = 8;
        break;
      case 'f':
        c = 12;
        break;
      case 'n':
        c = 10;
        break;
      case 'r':
        c = 13;
        break;
      case 't':
        c = 9;
        break;
      case 'u':
        if (i + 4 > s.size() - 1)
          throw std::runtime_error("CATALOG_JSON_ESCAPE");
        c = 0;
        for (int j = 0; j < 4; j++)
          c = (c << 4) | hex(s[i++]);
        break;
      case '"':
      case '\\':
      case '/':
        break;
      default:
        throw std::runtime_error("CATALOG_JSON_ESCAPE");
      }
    } else if (c >= 128) {
      int count;
      uint32_t minimum;
      if ((c & 0xe0) == 0xc0) {
        count = 1;
        c &= 31;
        minimum = 128;
      } else if ((c & 0xf0) == 0xe0) {
        count = 2;
        c &= 15;
        minimum = 2048;
      } else if ((c & 0xf8) == 0xf0) {
        count = 3;
        c &= 7;
        minimum = 65536;
      } else
        throw std::runtime_error("CATALOG_UTF8");
      for (int j = 0; j < count; j++) {
        if (i >= s.size() - 1)
          throw std::runtime_error("CATALOG_UTF8");
        auto b = static_cast<unsigned char>(s[i++]);
        if ((b & 192) != 128)
          throw std::runtime_error("CATALOG_UTF8");
        c = (c << 6) | (b & 63);
      }
      if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff))
        throw std::runtime_error("CATALOG_UTF8");
    } else if (c < 32)
      throw std::runtime_error("CATALOG_JSON_STRING");
    if (c > 65535) {
      c -= 65536;
      out.push_back(0xd800 + (c >> 10));
      out.push_back(0xdc00 + (c & 1023));
    } else
      out.push_back(c);
  }
  return out;
}
std::string utf8(const std::u16string &s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    uint32_t c = s[i];
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.size() && s[i + 1] >= 0xdc00 &&
        s[i + 1] <= 0xdfff)
      c = 0x10000 + ((c - 0xd800) << 10) + (s[++i] - 0xdc00);
    else if (c >= 0xd800 && c <= 0xdfff)
      c = 0xfffd;
    if (c < 128)
      out.push_back(c);
    else if (c < 2048) {
      out.push_back(192 | (c >> 6));
      out.push_back(128 | (c & 63));
    } else if (c < 65536) {
      out.push_back(224 | (c >> 12));
      out.push_back(128 | ((c >> 6) & 63));
      out.push_back(128 | (c & 63));
    } else {
      out.push_back(240 | (c >> 18));
      out.push_back(128 | ((c >> 12) & 63));
      out.push_back(128 | ((c >> 6) & 63));
      out.push_back(128 | (c & 63));
    }
  }
  return out;
}
class Parser {
  std::string_view input;
  size_t p = 0;
  bool copyMode;
  std::vector<std::u16string> jsonColumns;
  void space() {
    while (p < input.size() && (input[p] == ' ' || input[p] == '\n' ||
                                input[p] == '\r' || input[p] == '\t'))
      p++;
  }
  std::string_view string() {
    size_t start = p++;
    bool ended = false;
    while (p < input.size()) {
      char c = input[p++];
      if (c == '"') {
        ended = true;
        break;
      }
      if (c == '\\') {
        if (p >= input.size())
          break;
        p++;
      }
    }
    if (!ended)
      throw std::runtime_error("CATALOG_JSON_STRING");
    return input.substr(start, p - start);
  }
  Node value(unsigned depth, bool retain = true) {
    if (depth > 256)
      throw std::runtime_error("CATALOG_JSON_DEPTH");
    space();
    if (p >= input.size())
      throw std::runtime_error("CATALOG_JSON");
    size_t start = p;
    Node n;
    n.type = input[p];
    if (copyMode && depth == 1)
      jsonColumns.clear();
    if (n.type == '{' || n.type == '[') {
      char end = n.type == '{' ? '}' : ']';
      p++;
      space();
      if (p < input.size() && input[p] == end)
        p++;
      else
        for (;;) {
          std::string_view keyRaw;
          std::u16string key;
          if (n.type == '{') {
            space();
            if (p >= input.size() || input[p] != '"')
              throw std::runtime_error("CATALOG_JSON_KEY");
            keyRaw = string();
            if (retain)
              key = decode(keyRaw);
            space();
            if (p >= input.size() || input[p++] != ':')
              throw std::runtime_error("CATALOG_JSON_COLON");
          }
          bool opaque = copyMode && depth == 3 &&
                        std::find(jsonColumns.begin(), jsonColumns.end(),
                                  key) != jsonColumns.end();
          auto child = value(depth + 1, retain && !opaque);
          if (copyMode && depth == 1 && key == u"columns" &&
              child.type == '[') {
            for (auto &col : child.children)
              if (col.type == '[' && col.children.size() == 2 &&
                  col.children[0].type == '"' && col.children[1].type == '"') {
                auto type = decode(col.children[1].raw);
                if (type == u"jsonb" || type == u"jsonb_value")
                  jsonColumns.push_back(decode(col.children[0].raw));
              }
          }
          if (retain) {
            child.key = std::move(key);
            child.keyRaw = keyRaw;
            n.children.push_back(std::move(child));
          }
          space();
          if (p >= input.size())
            throw std::runtime_error("CATALOG_JSON_END");
          char c = input[p++];
          if (c == end)
            break;
          if (c != ',')
            throw std::runtime_error("CATALOG_JSON_SEPARATOR");
        }
    } else if (n.type == '"') {
      auto s = string();
      if (retain)
        decode(s);
    } else {
      while (p < input.size() && input[p] != ',' && input[p] != ']' &&
             input[p] != '}' && input[p] != ' ' && input[p] != '\n' &&
             input[p] != '\r' && input[p] != '\t')
        p++;
      auto s = input.substr(start, p - start);
      if (s != "null" && s != "true" && s != "false") {
        size_t i = 0;
        if (i < s.size() && s[i] == '-')
          i++;
        if (i == s.size())
          throw std::runtime_error("CATALOG_JSON_NUMBER");
        if (s[i] == '0')
          i++;
        else {
          if (s[i] < '1' || s[i] > '9')
            throw std::runtime_error("CATALOG_JSON_NUMBER");
          while (i < s.size() && s[i] >= '0' && s[i] <= '9')
            i++;
        }
        if (i < s.size() && s[i] == '.') {
          size_t a = ++i;
          while (i < s.size() && s[i] >= '0' && s[i] <= '9')
            i++;
          if (a == i)
            throw std::runtime_error("CATALOG_JSON_NUMBER");
        }
        if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
          i++;
          if (i < s.size() && (s[i] == '+' || s[i] == '-'))
            i++;
          size_t a = i;
          while (i < s.size() && s[i] >= '0' && s[i] <= '9')
            i++;
          if (a == i)
            throw std::runtime_error("CATALOG_JSON_NUMBER");
        }
        if (i != s.size())
          throw std::runtime_error("CATALOG_JSON_NUMBER");
      }
    }
    n.raw = input.substr(start, p - start);
    return n;
  }

public:
  explicit Parser(std::string_view s, bool copying = false)
      : input(s), copyMode(copying) {}
  Node parse() {
    auto n = value(0);
    space();
    if (p != input.size())
      throw std::runtime_error("CATALOG_JSON_TRAILING");
    return n;
  }
};
uint64_t index(const std::u16string &key) {
  constexpr uint64_t absent = UINT64_MAX;
  if (key.empty() || key.size() > 10 || (key.size() > 1 && key[0] == '0'))
    return absent;
  uint64_t n = 0;
  for (auto c : key) {
    if (c < '0' || c > '9')
      return absent;
    n = n * 10 + c - '0';
  }
  return n < 4294967295ULL ? n : absent;
}
void canonical(const Node &n, std::string &out) {
  if (n.type != '{' && n.type != '[') {
    out.append(n.raw);
    return;
  }
  out.push_back(n.type);
  bool first = true;
  if (n.type == '{') {
    std::vector<const Node *> sorted;
    sorted.reserve(n.children.size());
    for (auto &c : n.children)
      sorted.push_back(&c);
    std::sort(sorted.begin(), sorted.end(), [](auto *a, auto *b) {
      auto ai = index(a->key), bi = index(b->key);
      return ai != bi ? ai < bi : a->key < b->key;
    });
    for (auto *c : sorted) {
      if (!first)
        out.push_back(',');
      first = false;
      out.append(c->keyRaw);
      out.push_back(':');
      canonical(*c, out);
    }
  } else
    for (auto &c : n.children) {
      if (!first)
        out.push_back(',');
      first = false;
      canonical(c, out);
    }
  out.push_back(n.type == '{' ? '}' : ']');
}
std::string hash(std::string_view s) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  if (!SHA256(reinterpret_cast<const unsigned char *>(s.data()), s.size(),
              digest))
    throw std::runtime_error("CATALOG_SHA256");
  const char *hex = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (auto b : digest) {
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 15]);
  }
  return out;
}
struct Document {
  std::string bytes, hash;
};
Document document(const Node &n) {
  Document d;
  d.bytes.reserve(n.raw.size());
  canonical(n, d.bytes);
  d.hash = hash(d.bytes);
  return d;
}
void integer(std::string &out, uint64_t n, int size) {
  for (int i = size - 1; i >= 0; i--)
    out.push_back(static_cast<char>(n >> (i * 8)));
}
int64_t number(const Node &n) {
  auto s = n.raw;
  std::string decoded;
  if (n.type == '"') {
    decoded = utf8(decode(s));
    s = decoded;
  }
  int64_t v;
  auto r = std::from_chars(s.data(), s.data() + s.size(), v);
  if (r.ec != std::errc() || r.ptr != s.data() + s.size())
    throw std::runtime_error("COPY_INTEGER");
  return v;
}
std::string copy(const Node &table) {
  auto *cols = table.get(u"columns");
  auto *rows = table.get(u"rows");
  if (!cols || !rows || cols->type != '[' || rows->type != '[' ||
      cols->children.size() > 32767)
    throw std::runtime_error("COPY_SCHEMA");
  struct Column {
    std::u16string name, type;
  };
  std::vector<Column> columns;
  for (auto &c : cols->children) {
    if (c.type != '[' || c.children.size() != 2 || c.children[0].type != '"' ||
        c.children[1].type != '"')
      throw std::runtime_error("COPY_SCHEMA");
    columns.push_back({decode(c.children[0].raw), decode(c.children[1].raw)});
  }
  std::string out("PGCOPY\n\xff\r\n\0", 11);
  integer(out, 0, 4);
  integer(out, 0, 4);
  for (auto &row : rows->children) {
    if (row.type != '{')
      throw std::runtime_error("COPY_ROW");
    integer(out, columns.size(), 2);
    for (auto &c : columns) {
      auto *n = row.get(c.name);
      if (!n || (n->raw == "null" && c.type != u"jsonb_value")) {
        integer(out, UINT32_MAX, 4);
        continue;
      }
      auto offset = out.size();
      integer(out, 0, 4);
      auto start = out.size();
      if (c.type == u"jsonb" || c.type == u"jsonb_value") {
        out.push_back(1);
        out.append(n->raw);
      } else if (c.type == u"text") {
        if (n->type != '"')
          throw std::runtime_error("COPY_TEXT");
        out += utf8(decode(n->raw));
      } else if (c.type == u"bytea") {
        if (n->type != '"')
          throw std::runtime_error("COPY_BYTEA");
        auto raw = n->raw.substr(1, n->raw.size() - 2);
        if (raw.size() % 2)
          throw std::runtime_error("COPY_BYTEA");
        for (size_t i = 0; i < raw.size(); i += 2)
          out.push_back((hex(raw[i]) << 4) | hex(raw[i + 1]));
      } else if (c.type == u"uuid") {
        if (n->type != '"')
          throw std::runtime_error("COPY_UUID");
        auto s = utf8(decode(n->raw));
        if (s.size() != 36)
          throw std::runtime_error("COPY_UUID");
        for (size_t i = 0; i < s.size();) {
          if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i++] != '-')
              throw std::runtime_error("COPY_UUID");
          } else {
            auto a = hex(s[i++]);
            auto b = hex(s[i++]);
            out.push_back((a << 4) | b);
          }
        }
      } else if (c.type == u"integer") {
        auto v = number(*n);
        if (v < INT32_MIN || v > INT32_MAX)
          throw std::runtime_error("COPY_INTEGER_RANGE");
        integer(out, static_cast<uint64_t>(v), 4);
      } else if (c.type == u"bigint" || c.type == u"timestamptz")
        integer(out, static_cast<uint64_t>(number(*n)), 8);
      else
        throw std::runtime_error("COPY_TYPE");
      auto size = out.size() - start;
      if (size > INT32_MAX)
        throw std::runtime_error("COPY_FIELD_SIZE");
      for (int i = 0; i < 4; i++)
        out[offset + i] = static_cast<char>(size >> ((3 - i) * 8));
    }
  }
  integer(out, 65535, 2);
  return out;
}
void release(napi_env, void *, void *hint) {
  delete static_cast<std::string *>(hint);
}
napi_value buffer(napi_env env, std::string &&value) {
  auto p = std::make_unique<std::string>(std::move(value));
  napi_value v;
  check(napi_create_external_buffer(env, p->size(), p->data(), release, p.get(),
                                    &v));
  p.release();
  return v;
}
napi_value results(napi_env env, std::vector<Document> &docs, bool copyMode) {
  napi_value list;
  check(napi_create_array_with_length(env, docs.size(), &list));
  for (size_t i = 0; i < docs.size(); i++) {
    napi_value v;
    if (copyMode)
      v = buffer(env, std::move(docs[i].bytes));
    else {
      check(napi_create_object(env, &v));
      napi_value h;
      check(napi_create_string_utf8(env, docs[i].hash.data(),
                                    docs[i].hash.size(), &h));
      check(napi_set_named_property(env, v, "hash", h));
      if (!docs[i].bytes.empty())
        check(napi_set_named_property(env, v, "bytes",
                                      buffer(env, std::move(docs[i].bytes))));
    }
    check(napi_set_element(env, list, i, v));
  }
  return list;
}
struct Job {
  napi_async_work work{};
  napi_ref input{};
  napi_deferred deferred{};
  std::string_view source;
  int32_t mode = 0;
  std::string error;
  std::vector<Document> docs;
};
void execute(napi_env, void *data) {
  auto *j = static_cast<Job *>(data);
  try {
    auto tree = Parser(j->source, j->mode == 2).parse();
    if (tree.type != '[' || tree.children.size() > 65536)
      throw std::runtime_error("CATALOG_BATCH");
    j->docs.reserve(tree.children.size());
    for (auto &n : tree.children) {
      if (j->mode == 2)
        j->docs.push_back({copy(n), ""});
      else {
        auto d = document(n);
        if (j->mode == 0)
          d.bytes.clear();
        j->docs.push_back(std::move(d));
      }
    }
  } catch (const std::exception &e) {
    j->error = e.what();
  }
}
void complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Job> j(static_cast<Job *>(data));
  try {
    if (status != napi_ok)
      throw std::runtime_error("CATALOG_CANCELLED");
    if (!j->error.empty())
      throw std::runtime_error(j->error);
    check(napi_resolve_deferred(env, j->deferred,
                                results(env, j->docs, j->mode == 2)));
  } catch (const std::exception &e) {
    napi_value msg, err;
    napi_create_string_utf8(env, e.what(), NAPI_AUTO_LENGTH, &msg);
    napi_create_error(env, nullptr, msg, &err);
    napi_reject_deferred(env, j->deferred, err);
  }
  napi_delete_reference(env, j->input);
  napi_delete_async_work(env, j->work);
}
std::string_view input(napi_env env, napi_value v) {
  bool b;
  check(napi_is_buffer(env, v, &b));
  if (!b)
    throw std::runtime_error("CATALOG_BUFFER");
  void *data;
  size_t size;
  check(napi_get_buffer_info(env, v, &data, &size));
  return {static_cast<char *>(data), size};
}
napi_value batch(napi_env env, napi_callback_info info) {
  auto j = std::make_unique<Job>();
  try {
    size_t argc = 2;
    napi_value args[2];
    check(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 2)
      throw std::runtime_error("CATALOG_ARGUMENT");
    j->source = input(env, args[0]);
    check(napi_get_value_int32(env, args[1], &j->mode));
    if (j->mode < 0 || j->mode > 2)
      throw std::runtime_error("CATALOG_MODE");
    napi_value promise, name;
    check(napi_create_promise(env, &j->deferred, &promise));
    check(napi_create_reference(env, args[0], 1, &j->input));
    check(napi_create_string_utf8(env, "palimora:catalog", NAPI_AUTO_LENGTH,
                                  &name));
    check(napi_create_async_work(env, nullptr, name, execute, complete, j.get(),
                                 &j->work));
    check(napi_queue_async_work(env, j->work));
    j.release();
    return promise;
  } catch (const std::exception &e) {
    if (j->work)
      napi_delete_async_work(env, j->work);
    if (j->input)
      napi_delete_reference(env, j->input);
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}
napi_value compile(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value arg;
    check(napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr));
    if (argc != 1)
      throw std::runtime_error("CATALOG_ARGUMENT");
    auto tree = Parser(input(env, arg)).parse();
    auto *metadata = tree.get(u"metadata");
    if (tree.type != '{' || !metadata || tree.get(u"metadata_hash"))
      throw std::runtime_error("CATALOG_MANIFEST");
    Document md;
    md.bytes = "{\"metadata\":";
    canonical(*metadata, md.bytes);
    md.bytes += ",\"schema\":\"palimora-metadata-v1\"}";
    md.hash = hash(md.bytes);
    std::string quoted = "\"" + md.hash + "\"";
    Node field;
    field.type = '"';
    field.raw = quoted;
    field.key = u"metadata_hash";
    field.keyRaw = "\"metadata_hash\"";
    tree.children.push_back(std::move(field));
    std::vector<Document> docs;
    docs.push_back(std::move(md));
    docs.push_back(document(tree));
    return results(env, docs, false);
  } catch (const std::exception &e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}
} // namespace
napi_value initCatalog(napi_env env, napi_value exports) {
  napi_value fn;
  check(napi_create_function(env, "prepare", NAPI_AUTO_LENGTH, batch, nullptr,
                             &fn));
  check(napi_set_named_property(env, exports, "prepare", fn));
  check(napi_create_function(env, "compile", NAPI_AUTO_LENGTH, compile, nullptr,
                             &fn));
  check(napi_set_named_property(env, exports, "compile", fn));
  return exports;
}
