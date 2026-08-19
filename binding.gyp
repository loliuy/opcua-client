{
  "targets": [
    {
      "target_name": "opcua_open62541",
      "sources": ["src/addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!(node -e \"const path=require('path');console.log(process.env.OPEN62541_PREFIX||path.join(process.cwd(),'.build','open62541'))\")/include"
      ],
      "libraries": [
        "-L<!(node -e \"const path=require('path');console.log(process.env.OPEN62541_PREFIX||path.join(process.cwd(),'.build','open62541'))\")/lib",
        "-lopen62541"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags_cc": ["-std=c++20"],
      "conditions": [
        ["OS=='linux'", {"libraries": ["-lpthread", "-lm", "-lssl", "-lcrypto"]}]
      ]
    }
  ]
}
