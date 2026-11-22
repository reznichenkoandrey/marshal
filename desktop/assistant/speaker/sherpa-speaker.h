// The part of sherpa-onnx v1.13.8 `c-api.h` the speaker check uses (#287),
// copied verbatim for struct layout. The library itself is downloaded on
// demand and loaded with dlopen, so this must match that pinned version.
// sherpa-onnx is Apache-2.0: https://github.com/k2-fsa/sherpa-onnx

#include <stdint.h>

typedef struct SherpaOnnxSpeakerEmbeddingExtractorConfig {
  const char *model;
  int32_t num_threads;
  int32_t debug;
  const char *provider;
} SherpaOnnxSpeakerEmbeddingExtractorConfig;
