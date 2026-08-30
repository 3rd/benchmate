{
  description = "Development shell for benchmate";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      forEachSystem = nixpkgs.lib.genAttrs systems;

      bunVersion = "1.4.0";
      bunAssets = {
        "aarch64-darwin" = {
          name = "bun-darwin-aarch64";
          hash = "sha256-xmnpf2Fk4cluBwF0jbmN+ndJKQjL2DlMdVcTSnNd44E=";
        };
        "aarch64-linux" = {
          name = "bun-linux-aarch64";
          hash = "sha256-SxozLuhhmD65O8/m93D/+U4+MbLDiL2uo8jtNeWO7Q4=";
        };
        "x86_64-linux" = {
          name = "bun-linux-x64-baseline";
          hash = "sha256-GE+0WV8NQBohfPfHjBvEMLqDMU2reouUgFurv3+nCX8=";
        };
      };
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          asset = bunAssets.${system};
          bun = pkgs.bun.overrideAttrs {
            version = bunVersion;
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${asset.name}.zip";
              inherit (asset) hash;
            };
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              bun
              pkgs.nodejs_24
            ];

            env = nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
              PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
              PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
            };
          };
        }
      );
    };
}
