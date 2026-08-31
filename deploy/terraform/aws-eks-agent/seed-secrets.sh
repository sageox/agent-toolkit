#!/bin/sh
set -eu
export LC_ALL=C

if [ "$#" -ne 2 ]; then
  echo "usage: $0 </secret/prefix> <staged-secret-directory>" >&2
  exit 64
fi

secret_prefix=$1
secret_dir=$2

case "$secret_prefix" in
  /|/*/|*[!A-Za-z0-9/_+=.@-]*|[!/]*)
    echo "secret prefix must start with /, contain only Secrets Manager name characters, and not end with /" >&2
    exit 65
    ;;
esac

if [ ! -d "$secret_dir" ]; then
  echo "secret directory does not exist: $secret_dir" >&2
  exit 66
fi

found=false
for secret_path in "$secret_dir"/*; do
  [ -f "$secret_path" ] || continue
  found=true
  secret_name=${secret_path##*/}
  case "$secret_name" in
    [A-Za-z_]*) ;;
    *)
      echo "refusing non-secretRef file name: $secret_name" >&2
      exit 65
      ;;
  esac
  case "$secret_name" in
    *[!A-Za-z0-9_]*|*/*)
      echo "refusing non-secretRef file name: $secret_name" >&2
      exit 65
      ;;
  esac
  if [ -L "$secret_path" ]; then
    echo "refusing symlinked secret file: $secret_name" >&2
    exit 65
  fi
  if [ ! -s "$secret_path" ]; then
    echo "refusing empty secret file: $secret_name" >&2
    exit 65
  fi
  aws secretsmanager put-secret-value \
    --secret-id "$secret_prefix/$secret_name" \
    --secret-string "file://$secret_path" >/dev/null
  echo "seeded $secret_prefix/$secret_name"
done

if [ "$found" = false ]; then
  echo "no staged secret files found in $secret_dir" >&2
  exit 66
fi
