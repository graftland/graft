{
  pkgs,
  multiverse,
  ...
}:

{
  devenv.warnOnNewVersion = false;

  packages =
    with pkgs;
    [
      git
      gh
      corepack
      ripgrep
    ]
    ++ lib.optionals stdenv.isLinux [
      bubblewrap
      util-linux
    ];

  languages = {
    javascript = {
      enable = true;
      lsp.enable = false;
      package = multiverse.nodejs_26."26.12.1";
    };
  };

  treefmt = {
    enable = true;
    config = {
      projectRootFile = "devenv.nix";
      settings.global.excludes = [
        ".agents/**"
        ".claude/**"
        "references/**"
        # Generated raw benchmark samples can be large; keep their JSON output format.
        "packages/benchmarks/results/*.json"
      ];
      programs = {
        prettier.enable = true;
        nixfmt.enable = true;
      };
    };
  };
}
