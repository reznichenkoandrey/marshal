// The part of sherpa-onnx v1.13.8 `c-api.h` the wake listener uses (#274),
// copied verbatim for struct layout. The library itself is downloaded on
// demand and loaded with dlopen, so these must match that pinned version.
// sherpa-onnx is Apache-2.0: https://github.com/k2-fsa/sherpa-onnx

#include <stdint.h>

typedef struct SherpaOnnxOnlineTransducerModelConfig {
  const char *encoder;
  const char *decoder;
  const char *joiner;
} SherpaOnnxOnlineTransducerModelConfig;

typedef struct SherpaOnnxOnlineParaformerModelConfig {
  const char *encoder;
  const char *decoder;
} SherpaOnnxOnlineParaformerModelConfig;

typedef struct SherpaOnnxOnlineZipformer2CtcModelConfig {
  const char *model;
} SherpaOnnxOnlineZipformer2CtcModelConfig;

typedef struct SherpaOnnxOnlineNemoCtcModelConfig {
  const char *model;
} SherpaOnnxOnlineNemoCtcModelConfig;

typedef struct SherpaOnnxOnlineToneCtcModelConfig {
  const char *model;
} SherpaOnnxOnlineToneCtcModelConfig;

typedef struct SherpaOnnxOnlineModelConfig {
  SherpaOnnxOnlineTransducerModelConfig transducer;
  SherpaOnnxOnlineParaformerModelConfig paraformer;
  SherpaOnnxOnlineZipformer2CtcModelConfig zipformer2_ctc;
  const char *tokens;
  int32_t num_threads;
  const char *provider;
  int32_t debug;
  const char *model_type;
  const char *modeling_unit;
  const char *bpe_vocab;
  const char *tokens_buf;
  int32_t tokens_buf_size;
  SherpaOnnxOnlineNemoCtcModelConfig nemo_ctc;
  SherpaOnnxOnlineToneCtcModelConfig t_one_ctc;
} SherpaOnnxOnlineModelConfig;

typedef struct SherpaOnnxFeatureConfig {
  int32_t sample_rate;
  int32_t feature_dim;
} SherpaOnnxFeatureConfig;

typedef struct SherpaOnnxKeywordResult {
  const char *keyword;
  const char *tokens;
  const char *const *tokens_arr;
  int32_t count;
  float *timestamps;
  float start_time;
  const char *json;
} SherpaOnnxKeywordResult;

typedef struct SherpaOnnxKeywordSpotterConfig {
  SherpaOnnxFeatureConfig feat_config;
  SherpaOnnxOnlineModelConfig model_config;
  int32_t max_active_paths;
  int32_t num_trailing_blanks;
  float keywords_score;
  float keywords_threshold;
  const char *keywords_file;
  const char *keywords_buf;
  int32_t keywords_buf_size;
} SherpaOnnxKeywordSpotterConfig;
