#!/usr/bin/env bash
# Page through Kokoro US-voice auditions at your own pace.
# Controls:  enter = next · r = replay · q = quit · s = stop · N = jump to track N
set -euo pipefail
cd "$(dirname "$0")"

# -u: audition WAVs are gitignored (*.wav) and fd skips ignored files by
# default — without it this lists nothing inside the repo.
mapfile -t Wavs < <(fd -g -u '*.wav' . | sort)
echo "${#Wavs[@]} voices. enter=next  r=replay  q=quit  s=stop  N=jump"
echo

i=0
while [ "$i" -lt "${#Wavs[@]}" ]; do
    f="${Wavs[$i]}"
    next=$((i + 1))
    while :; do
        echo "▶ [$(printf '%02d' $((i + 1)))/${#Wavs[@]})] ${f##*/}"
        paplay "$f"
        read -rp "enter=next  r=replay  q=quit  s=stop  N=jump: " k
        case "$k" in
        r) continue ;;
        q | s) exit 0 ;;
        '') break ;;
        [0-9]*)
            n=$((10#$k))
            if [ "$n" -ge 1 ] && [ "$n" -le "${#Wavs[@]}" ]; then
                next=$((n - 1))
                break
            fi
            echo "out of range: $k"
            continue
            ;;
        *)
            echo "unknown key"
            continue
            ;;
        esac
    done
    i=$next
done
echo "done."
