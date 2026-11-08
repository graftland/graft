#include <node_api.h>
#include <unistd.h>

static int calls = 0;

static napi_value next(napi_env env, napi_callback_info info) {
  napi_value value;
  napi_create_int32(env, ++calls, &value);
  return value;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function, pid;
  napi_create_function(env, "next", NAPI_AUTO_LENGTH, next, NULL, &function);
  napi_set_named_property(env, exports, "next", function);
  napi_create_int32(env, getpid(), &pid);
  napi_set_named_property(env, exports, "pid", pid);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
