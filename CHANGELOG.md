# Changelog

## [0.3.0](https://github.com/dcc-mcp/adobepy/compare/adobepy-v0.2.0...adobepy-v0.3.0) (2026-06-09)


### Features

* add PyOxidizer standalone interpreter build to release workflow ([2c41083](https://github.com/dcc-mcp/adobepy/commit/2c410834c7d11e1e2f6002dedd00062f8dffba43))


### Bug Fixes

* address review feedback on PyOxidizer standalone interpreter build ([10c8757](https://github.com/dcc-mcp/adobepy/commit/10c8757809d58c7fd8443ab432a6985b4c2be9e9))
* trigger CI on release-please PRs using a PAT ([4fa5bfd](https://github.com/dcc-mcp/adobepy/commit/4fa5bfd784833d45efdc6ecd6753eaee24cf61e5))

## [0.2.0](https://github.com/dcc-mcp/adobepy/compare/adobepy-v0.1.0...adobepy-v0.2.0) (2026-06-08)


### Features

* add abi3 native packaging canary ([20f68b3](https://github.com/dcc-mcp/adobepy/commit/20f68b303947b186a0fb26a6120c2b7f084188cb))
* add after effects item facades ([fee008e](https://github.com/dcc-mcp/adobepy/commit/fee008ecda9e988590306360abdd538d1a3d08fa))
* add after effects layer facades ([05e0acb](https://github.com/dcc-mcp/adobepy/commit/05e0acb63cc68db84b6de2e74c9c63b694b0a79b))
* add after effects render queue facades ([599dbcb](https://github.com/dcc-mcp/adobepy/commit/599dbcb5d19eae2cd99bb3544469b053e051c403))
* add api source registry and replay tests ([29f09b6](https://github.com/dcc-mcp/adobepy/commit/29f09b65947341f73e9f5d063be4287b50b06498))
* add architecture quality gates ([92fee5e](https://github.com/dcc-mcp/adobepy/commit/92fee5e8d67359c01c83fe82f1e941e7ac50b233))
* add dcc mcp integration helpers ([2d930f1](https://github.com/dcc-mcp/adobepy/commit/2d930f1e70f78a4a350f37384e64bea32e4da016))
* add generated facade stub drift checks ([07ac7a1](https://github.com/dcc-mcp/adobepy/commit/07ac7a16a1393e176d557f469429d9bea91d232d))
* add illustrator artboard facades ([72f914e](https://github.com/dcc-mcp/adobepy/commit/72f914ece101a16c5be6c158b91588cf216fe69f))
* add illustrator geometry facades ([82ccf93](https://github.com/dcc-mcp/adobepy/commit/82ccf934aef29730e02e03ed48fb24ddec360df0))
* add illustrator text export facades ([2614f18](https://github.com/dcc-mcp/adobepy/commit/2614f182d9579adfdbb4cbc728bbabadfa53f79c))
* add indesign page facades ([1f3e5dc](https://github.com/dcc-mcp/adobepy/commit/1f3e5dc30b79eadfda0c96ecd2bb629c2697a716))
* add indesign production facades ([3506747](https://github.com/dcc-mcp/adobepy/commit/3506747356e592a09909d0ba1748e9682a7c17f9))
* add indesign text facades ([97605b1](https://github.com/dcc-mcp/adobepy/commit/97605b1e715da7c32120735590f9fe74da7d27e7))
* add install smoke test and release asset upload ([c079057](https://github.com/dcc-mcp/adobepy/commit/c079057bcdc0457bb96283481d58dd29061fff11))
* add live host smoke workflow ([28cb9a8](https://github.com/dcc-mcp/adobepy/commit/28cb9a8ba860ce1503cf31ba45c8b8c1e8292705))
* add photoshop selection channel facades ([243b74b](https://github.com/dcc-mcp/adobepy/commit/243b74b364b3704cc6faa3e43e8e9b3c11305aa1))
* add photoshop smart export facades ([693f7d2](https://github.com/dcc-mcp/adobepy/commit/693f7d2c5be21f9404b50d54e5729ec8f0bb2538))
* add photoshop text facades ([66712cb](https://github.com/dcc-mcp/adobepy/commit/66712cbbd9b3c5df438b8c618e341c7a89174981))
* add premiere encoder export facades ([776bc47](https://github.com/dcc-mcp/adobepy/commit/776bc474ab196256540b3e8edc84355de6fa3ed1))
* add premiere project item facades ([b517e2c](https://github.com/dcc-mcp/adobepy/commit/b517e2ca05434104a95ec7b9d5f403249f1ff658))
* add premiere sequence facades ([33992f5](https://github.com/dcc-mcp/adobepy/commit/33992f56aa66d9d5276612fe41ab84f40941b5ce))
* add release-please for automated version bump, changelog, and tag management ([5c9db13](https://github.com/dcc-mcp/adobepy/commit/5c9db13d174cd4b7d5e56a3476a5e9a32df4534b))
* bootstrap adobepy shared adobe bridge runtime ([f3707c6](https://github.com/dcc-mcp/adobepy/commit/f3707c677ea3f02ed0a98c0e02d015da542a7a48))
* generate runtime facade contracts ([ee586dc](https://github.com/dcc-mcp/adobepy/commit/ee586dcded8b017c1967d0127206b3794dc39e84))
* track adobe api coverage targets ([5d90489](https://github.com/dcc-mcp/adobepy/commit/5d9048980873778a99ae5d2c2261f04559f68fb6))


### Bug Fixes

* add wildcard to Get-ChildItem path so -Include actually filters ([0b0e2fc](https://github.com/dcc-mcp/adobepy/commit/0b0e2fc5120ceff0a9c0526ae2ffde913157c9f9))
* align release workflow with pypi publisher ([5bc8e15](https://github.com/dcc-mcp/adobepy/commit/5bc8e152c00a450d89f76e9245995dccfd6de811))
* enforce py38 abi3 wheel compatibility ([e1ac905](https://github.com/dcc-mcp/adobepy/commit/e1ac90545ced3e30273c90dbb008ad6cf519df5b))
* use Get-ChildItem for release upload glob and tighten doctor assertions ([88ff314](https://github.com/dcc-mcp/adobepy/commit/88ff3143a239cd0f23cf6edfbd349b67cf0b6f83))


### Documentation

* add support matrix, distribution contract and runtime discovery docs ([#24](https://github.com/dcc-mcp/adobepy/issues/24)) ([8590405](https://github.com/dcc-mcp/adobepy/commit/8590405b3a7874cd4e7aa5277e9f0f5c7ba900bf))
* clarify dcc mcp migration path ([43ade3b](https://github.com/dcc-mcp/adobepy/commit/43ade3b6545b81c56e2954550d4c41b9478d3bfe))
