# [1.12.0](https://github.com/3rd/benchmate/compare/v1.11.0...v1.12.0) (2024-12-21)

### Features

- account for jit optimizations and outliers ([77a814b](https://github.com/3rd/benchmate/commit/77a814bfd44728708367109ab0e3a7f521aace1b))

# [1.11.0](https://github.com/3rd/benchmate/compare/v1.10.0...v1.11.0) (2024-12-20)

### Features

- pass task to setup hook ([eb8023b](https://github.com/3rd/benchmate/commit/eb8023bb217c32498b971eb29a4ece4a12be2d0f))

# [1.10.0](https://github.com/3rd/benchmate/compare/v1.9.0...v1.10.0) (2024-12-20)

### Features

- emit elapsed time on progress ([c00a107](https://github.com/3rd/benchmate/commit/c00a107b2b47fe13d05144c2adc6fb43b0a086e0))

# [1.9.0](https://github.com/3rd/benchmate/compare/v1.8.0...v1.9.0) (2024-12-20)

### Features

- add support for unsubscribing from events ([c68dd87](https://github.com/3rd/benchmate/commit/c68dd87921d7362d5693f5d1301d481b02a5ad1b))

# [1.8.0](https://github.com/3rd/benchmate/compare/v1.7.1...v1.8.0) (2024-12-19)

### Features

- add benchmark events ([e27c031](https://github.com/3rd/benchmate/commit/e27c03177582dfac956569ed6bfc348e8cadafeb))

## [1.7.1](https://github.com/3rd/benchmate/compare/v1.7.0...v1.7.1) (2023-07-15)

### Bug Fixes

- lint, update deps, use pnpm's run_install ([9d33a29](https://github.com/3rd/benchmate/commit/9d33a298a4bcfd0aae907570b94c5b8b9a5e5e9a))

# [1.7.0](https://github.com/3rd/benchmate/compare/v1.6.0...v1.7.0) (2023-06-25)

### Features

- use simple-statistics for stats computations ([ecd741c](https://github.com/3rd/benchmate/commit/ecd741c9388b9df9872f8babe9cf3166c5fed9ab))

# [1.6.0](https://github.com/3rd/benchmate/compare/v1.5.0...v1.6.0) (2023-06-22)

### Bug Fixes

- pad when formatting iterations ([3bc736d](https://github.com/3rd/benchmate/commit/3bc736d2747eb634dd625bea0d6d43a55f60c707))

### Features

- add custom metrics summary table and improve output ([8b7b9e1](https://github.com/3rd/benchmate/commit/8b7b9e1208631a0a5e1d7944aab5145fe86638cf))
- default to quiet in browser envs ([28ee313](https://github.com/3rd/benchmate/commit/28ee31313f87d3a30caa247683e3b3f83a248ddd))

# [1.5.0](https://github.com/3rd/benchmate/compare/v1.4.0...v1.5.0) (2023-06-22)

### Features

- colorize default output ([113decc](https://github.com/3rd/benchmate/commit/113deccde5c9c7a2151e5f157d119ad8239401f0))

# [1.4.0](https://github.com/3rd/benchmate/compare/v1.3.0...v1.4.0) (2023-06-22)

### Features

- add margin and ratio comparison ([a4332ff](https://github.com/3rd/benchmate/commit/a4332ff3466caf5693200dc2a4ab3e0542b0d56f))

# [1.3.0](https://github.com/3rd/benchmate/compare/v1.2.0...v1.3.0) (2023-06-20)

### Features

- sort result summary by ops and simplify single result printing ([2e2c81d](https://github.com/3rd/benchmate/commit/2e2c81d965cd053f8e706971fdfa5e3cc11595c9))

# [1.2.0](https://github.com/3rd/benchmate/compare/v1.1.0...v1.2.0) (2023-06-20)

### Features

- refactor BenchmarkOptions, fix math, prettier units, add debug flag and logging ([68d7be1](https://github.com/3rd/benchmate/commit/68d7be1db15ee7510769aa2562ac7b713e43ddcf))

# [1.1.0](https://github.com/3rd/benchmate/compare/v1.0.3...v1.1.0) (2023-06-20)

### Features

- compile test functions and auto-compute task iterations based on target time ([9fb4a9b](https://github.com/3rd/benchmate/commit/9fb4a9b4b603a7d4bcee77995232c69120ec98b5))

## [1.0.3](https://github.com/3rd/benchmate/compare/v1.0.2...v1.0.3) (2023-06-20)

### Bug Fixes

- fix auto-computed batch size not used ([0a10733](https://github.com/3rd/benchmate/commit/0a1073387d23c62a598280dac88415a3cf8560ff))

## [1.0.2](https://github.com/3rd/benchmate/compare/v1.0.1...v1.0.2) (2023-06-19)

### Bug Fixes

- fix usage ([8f85fd9](https://github.com/3rd/benchmate/commit/8f85fd9d626210f6ad13225c7331c8eb77928b28))
- remove default test sleep ([7ff9caa](https://github.com/3rd/benchmate/commit/7ff9caafbd265db7e4766797331b9dfdb32f1dca))
- update printResult to format output ([9f40d99](https://github.com/3rd/benchmate/commit/9f40d990f908fa6ad1185afa5c95488288150244))

### Features

- genesis ([9ec8aee](https://github.com/3rd/benchmate/commit/9ec8aee1e607c6ece8e6808fc74caba594a2443d))
- percentiles & auto-compute batch size and warmup iteration count ([90aa186](https://github.com/3rd/benchmate/commit/90aa18656506097f65cf5a85cb2c336f58b2bebd))
- print percentiles for single results ([3a87751](https://github.com/3rd/benchmate/commit/3a87751f93adb0ff42aac9ae5513e8584c5c7ee2))
