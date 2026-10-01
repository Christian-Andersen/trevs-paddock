{
  description = "Frontend development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config.permittedInsecurePackages = [ "pnpm-12.8.1" ];
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          git
          just
          nodejs
          prek
        ];
      };
    };
}
