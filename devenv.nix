{
  pkgs,
  multiverse,
  ...
}:

{
  devenv.warnOnNewVersion = false;

  packages = with pkgs; [
    git
    gh
    corepack
    ripgrep
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
      ];
      programs = {
        prettier.enable = true;
        nixfmt.enable = true;
      };
    };
  };
}
