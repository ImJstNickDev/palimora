#!/usr/bin/env bash
set -euo pipefail
# Apache-2.0; pinned upstream release, verified before executing or installing.
version=0.15.1
case "$(uname -m)" in
  x86_64) arch=x86_64; digest=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c ;;
  aarch64) arch=aarch64; digest=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee ;;
  *) echo 'Unsupported typesetter architecture' >&2; exit 1 ;;
esac
install_dir="${1:?Pass an installation directory}"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
archive="typst-${arch}-unknown-linux-musl"
curl --fail --location --silent --show-error "https://github.com/typst/typst/releases/download/v${version}/${archive}.tar.xz" -o "$work_dir/typst.tar.xz"
echo "$digest  $work_dir/typst.tar.xz" | sha256sum --check --status
tar -xJf "$work_dir/typst.tar.xz" -C "$work_dir"
mkdir -p "$install_dir"
install -m 755 "$work_dir/$archive/typst" "$install_dir/typst"
install -m 644 "$work_dir/$archive/LICENSE" "$install_dir/typst-LICENSE"
install -m 644 "$work_dir/$archive/NOTICE" "$install_dir/typst-NOTICE"
