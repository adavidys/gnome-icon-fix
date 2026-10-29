#!/bin/sh
# Builds the fake home the tests run in: what each launcher, native and
# Flatpak, leaves on disk for one game ("Some Game"), plus some odd cases.
#
#     fixture.sh HOME_DIR PE_DIR      (PE_DIR: output of make-pe.py)
set -e
F=$1
PE=$2
rm -rf "$F"
G="$F/Games/Some Game"
mkdir -p "$G"
cp "$PE/png.exe" "$G/Some Game.exe"
cp "$PE/pe32.exe" "$G/Tool \"Pro\".exe"
cp "$PE/notpe.exe" "$G/Broken.exe"

png() { # png FILE [HEIGHT]: a 4 px wide picture, 4 px high by default
python3 -c 'import sys,struct,zlib
h=int(sys.argv[1])
def c(k,d): return struct.pack(">I",len(d))+k+d+struct.pack(">I",zlib.crc32(k+d)&0xffffffff)
sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n"+c(b"IHDR",struct.pack(">IIBBBBB",4,h,8,6,0,0,0))+c(b"IDAT",zlib.compress(b"".join(b"\0"+b"\x10\x20\x30\xff"*4 for _ in range(h))))+c(b"IEND",b""))' "${2:-4}" > "$1"; }

vdf_shortcuts() { # vdf_shortcuts FILE EXE [ICON]: one non-Steam game, app id 2236688360
python3 - "$@" <<'EOF'
import sys, struct
def s(k, v): return b'\x01' + k.encode() + b'\0' + v.encode() + b'\0'
def i(k, v): return b'\x02' + k.encode() + b'\0' + struct.pack('<i', v)
appid = struct.unpack('<i', struct.pack('<I', 2236688360))[0]
icon = sys.argv[3] if len(sys.argv) > 3 else ''
entry = b'\x00' + b'0\0' + i('appid', appid) + s('AppName', 'Some Game.exe') + s('Exe', '"%s"' % sys.argv[2]) + s('icon', icon) + b'\x03LastPlayTime\0' + struct.pack('<f', 1.0) + b'\x07Big\0' + struct.pack('<Q', 7) + b'\x00tags\0\x08' + b'\x08'
other = b'\x00' + b'1\0' + s('AppName', 'No Id') + b'\x08'
bare = b'\x00' + b'2\0' + i('appid', 5) + b'\x08'
stray = s('note', 'not a shortcut')
open(sys.argv[1], 'wb').write(b'\x00shortcuts\0' + entry + other + bare + stray + b'\x08\x08')
EOF
}

# --- Steam (native): two libraries, Half-Life (70) and an old one (80)
ST=$F/.local/share/Steam
mkdir -p "$ST/steamapps/common/Half-Life" "$ST/userdata/111/config" "$ST/appcache/librarycache/70" "$F/SteamLib2/steamapps/common/CS"
touch "$ST/steamapps/common/Half-Life/hl_linux" "$F/SteamLib2/steamapps/common/CS/hl_linux"
cat > "$ST/steamapps/libraryfolders.vdf" <<EOF
"libraryfolders"
{
	"0"
	{
		"path"		"$ST"
	}
	"1"		"$F/SteamLib2"
	"2"
	{
		"label"		"no path"
	}
	// a comment
}
EOF
printf '"AppState"\n{\n "appid" "70"\n "name" "Half-Life"\n "installdir" "Half-Life"\n}\n' > "$ST/steamapps/appmanifest_70.acf"
printf '"AppState"\n{\n "appid" "80"\n "Name" "Counter-Strike \\"CS\\""\n "installdir" "CS"\n}\n' > "$F/SteamLib2/steamapps/appmanifest_80.acf"
printf '"AppState"\n{\n "appid" "90"\n}\n' > "$ST/steamapps/appmanifest_90.acf"
png "$ST/appcache/librarycache/70/95be6d131fc61f145797317ca437c9765f24b41c.jpg"
png "$ST/appcache/librarycache/70/header.jpg"
png "$ST/appcache/librarycache/80_icon.jpg"
mkdir -p "$ST/appcache/librarycache/75" "$ST/steamapps/appmanifest_91.acf" "$ST/userdata/333" "$F/.local/share/icons/hicolor/32x32/apps"
png "$ST/appcache/librarycache/75/0123456789abcdef0123456789abcdef01234567.jpg"
png "$F/.local/share/icons/hicolor/32x32/apps/steam_icon_71.png"
printf '"Other"\n{\n "appid" "92"\n}\n' > "$ST/steamapps/appmanifest_92.acf"
printf '"AppState"\n{\n "appid" "93"\n "installdir" "Nameless"\n}\n' > "$ST/steamapps/appmanifest_93.acf"
vdf_shortcuts "$ST/userdata/111/config/shortcuts.vdf" "$G/Some Game.exe"
mkdir -p "$F/.steam"
ln -s ../.local/share/Steam "$F/.steam/steam"
# Snap Steam: a link by absolute path, to a root without any library yet
mkdir -p "$F/snap/steam/common/.local/share" "$F/SnapSteam"
ln -s "$F/SnapSteam" "$F/snap/steam/common/.local/share/Steam"

# --- Steam (Flatpak)
FS=$F/.var/app/com.valvesoftware.Steam
# A libraryfolders.vdf that can't be read (here: a folder)
mkdir -p "$FS/.local/share/Steam/steamapps/libraryfolders.vdf"
mkdir -p "$FS/.local/share/applications" "$FS/Desktop" "$FS/.local/share/icons/hicolor/32x32/apps" "$FS/.local/share/Steam/userdata/222/config"
printf '[Desktop Entry]\nName=Half-Life\nComment=Play this game on Steam\nExec=steam steam://rungameid/70\nIcon=steam_icon_70\nTryExec=steam\nTerminal=false\nType=Application\nCategories=Game;\n' > "$FS/.local/share/applications/Half-Life.desktop"
printf '[Desktop Entry]\nName=Not A Game\nExec=steam steam://open/news\nType=Application\n' > "$FS/.local/share/applications/news.desktop"
printf '[Desktop Entry]\nName=No Exec\nType=Application\n' > "$FS/.local/share/applications/noexec.desktop"
printf 'this is not a key file\n' > "$FS/.local/share/applications/broken.desktop"
printf 'not a desktop file\n' > "$FS/.local/share/applications/readme.txt"
png "$FS/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png"
printf '[Desktop Entry]\nName=Some Game.exe\nComment=Play this game on Steam\nExec=steam steam://rungameid/9606503357577428992\nIcon=\nTerminal=false\nType=Application\nCategories=Game;\n' > "$FS/Desktop/Some Game.exe.desktop"
printf '[Desktop Entry]\nName=Half-Life\nExec=steam steam://rungameid/70\nIcon=/nonexistent/icon.png\nType=Application\n' > "$FS/Desktop/Half-Life.desktop"
printf '[Desktop Entry]\nName=Gone.exe\nExec=steam steam://rungameid/53021404823552\nType=Application\n' > "$FS/Desktop/Gone.exe.desktop"
png "$F/custom-icon.png"
vdf_shortcuts "$FS/.local/share/Steam/userdata/222/config/shortcuts.vdf" "$G/Some Game.exe" "$F/custom-icon.png"

# --- Heroic (native): every store
H=$F/.config/heroic
mkdir -p "$H/sideload_apps" "$H/legendaryConfig/legendary" "$H/gog_store" "$H/nile_config/nile" "$H/GamesConfig" "$H/icons" "$F/Games/Epic/Epic Game" "$F/Games/GOG/Gog Game" "$F/Games/Amazon/Amazon Game"
cp "$PE/pe32.exe" "$F/Games/Epic/Epic Game/EpicGame.exe"
cat > "$H/sideload_apps/library.json" <<EOF
{"games": [{"runner": "sideload", "app_name": "abc123", "title": "Some Game (Heroic)", "install": {"executable": "$G/Some Game.exe"}},
           {"runner": "sideload", "app_name": "nofolder", "title": "Nowhere", "install": {"executable": "/usr/bin/x"}},
           {"runner": "sideload", "app_name": "brokenexe", "title": "Broken", "install": {"executable": "$G/Broken.exe"}},
           {"runner": "sideload", "title": "No Name"},
           {"runner": "sideload", "app_name": "nat999", "title": "Some Game (Heroic, in the Flatpak's prefix)", "install": {"executable": "$G/Some Game.exe"}}]}
EOF
cat > "$H/legendaryConfig/legendary/installed.json" <<EOF
{"epicgame": {"app_name": "epicgame", "title": "Epic Game", "install_path": "$F/Games/Epic/Epic Game", "executable": "EpicGame.exe"}}
EOF
printf '{"installed": [{"appName": "1207", "install_path": "%s/Games/GOG/Gog Game"}]}\n' "$F" > "$H/gog_store/installed.json"
printf '[{"id": "amzn1", "path": "%s/Games/Amazon/Amazon Game"}]\n' "$F" > "$H/nile_config/nile/installed.json"
printf '{"abc123": {"winePrefix": "%s/Games/Heroic/Prefixes/Some Game"}, "version": "v0"}\n' "$F" > "$H/GamesConfig/abc123.json"
printf '{"epicgame": {"winePrefix": "%s/Games/Heroic/Prefixes/Shared"}}\n' "$F" > "$H/GamesConfig/epicgame.json"
printf '{"1207": {"winePrefix": "%s/Games/Heroic/Prefixes/Shared"}}\n' "$F" > "$H/GamesConfig/1207.json"
printf '{"amzn1": {}}\n' > "$H/GamesConfig/amzn1.json"
# The Flatpak's prefix, as Proton's WINEPREFIX names it (Prefixes/Flat/pfx)
printf '{"nat999": {"winePrefix": "%s/Games/Heroic/Prefixes/Flat/pfx"}}\n' "$F" > "$H/GamesConfig/nat999.json"
printf 'not json' > "$H/GamesConfig/broken.json"
ln -s "$F/nowhere.json" "$H/GamesConfig/gone.json"
png "$H/icons/epicgame.jpg"
# A cover Heroic saved instead of an icon, for a game without an .exe
png "$H/icons/1207.png" 6

# --- Heroic (Flatpak)
HF=$F/.var/app/com.heroicgameslauncher.hgl/config/heroic
mkdir -p "$HF/sideload_apps" "$HF/GamesConfig"
cat > "$HF/sideload_apps/library.json" <<EOF
{"games": [{"runner": "sideload", "app_name": "flat999", "title": "Some Game (Heroic Flatpak)", "install": {"executable": "$G/Some Game.exe"}}]}
EOF
printf '{"flat999": {"winePrefix": "%s/Games/Heroic/Prefixes/Flat"}}\n' "$F" > "$HF/GamesConfig/flat999.json"
# A cover Heroic saved instead of an icon: its .exe's icon goes first
mkdir -p "$HF/icons"
png "$HF/icons/flat999.png" 6

# --- Lutris (native and Flatpak)
mkdir -p "$F/.config/lutris/games" "$F/.local/share/lutris/games" "$F/Games/lutris-pfx" "$F/Games/Other Game" "$F/.local/share/icons/hicolor/128x128/apps"
cat > "$F/.config/lutris/games/some-game-1700000000.yml" <<EOF
game:
  exe: $G/Some Game.exe
  prefix: $F/Games/lutris-pfx
system:
  env: {}
EOF
cat > "$F/.local/share/lutris/games/other-game-1700000002.yaml" <<EOF
game:
  working_dir: $F/Games/Other Game
EOF
printf 'game: [\n' > "$F/.config/lutris/games/broken-1.yml"
printf 'game:\n  exe: %s/Gone.exe\n' "$G" > "$F/.config/lutris/games/gone-game-1700000004.yml"
printf 'game:\n  exe: %s/Broken.exe\n' "$G" > "$F/.config/lutris/games/broken-game-1700000005.yml"
cat > "$F/.config/lutris/games/plain-game-1700000003.yml" <<EOF
game:
  exe: $G/Some Game.exe
EOF
png "$F/.local/share/icons/hicolor/128x128/apps/lutris_other-game.png"
LF=$F/.var/app/net.lutris.Lutris
mkdir -p "$LF/data/lutris/games" "$LF/data/icons/hicolor/128x128/apps" "$F/Games/lutris-flat"
cat > "$LF/data/lutris/games/some-game-1700000001.yml" <<EOF
game:
  exe: $G/Some Game.exe
  prefix: $F/Games/lutris-flat
EOF
png "$LF/data/icons/hicolor/128x128/apps/lutris_some-game.png"

# --- Bottles: a Flatpak bottle whose Name differs from its folder, and a native one with the same Name
bottle() { # bottle DIR ICON?
mkdir -p "$1/icons"
cat > "$1/bottle.yml" <<EOF
Name: Some Bottle
Runner: soda-11.0
External_Programs:
  abc:
    executable: Some Game.exe
    name: Some Game
    path: $G/Some Game.exe
  def:
    executable: Tool "Pro".exe
    name: Tool "Pro" & Co
    path: $G/Tool "Pro".exe
  ghi:
    executable: Hidden.exe
    name: Hidden Thing
    path: $G/Hidden.exe
    removed: true
  jkl:
    name: No Path
  mno:
    name: Rel
    path: rel/x.exe
  pqr:
    name: Broken
    executable: Broken.exe
    path: $G/Broken.exe
EOF
[ -n "$2" ] && png "$1/icons/Some Game.png"
true
}
bottle "$F/.var/app/com.usebottles.bottles/data/bottles/bottles/SomeBottle" icon
bottle "$F/.local/share/bottles/bottles/SomeBottle" icon
mkdir -p "$F/.var/app/com.usebottles.bottles/data/bottles/bottles/Empty" "$F/.var/app/com.usebottles.bottles/data/bottles/bottles/NoConfig"
printf 'Name: [\n  - x\n' > "$F/.var/app/com.usebottles.bottles/data/bottles/bottles/Empty/bottle.yml"

# --- Plain Wine prefix with drive letters
W=$F/.wine-game
mkdir -p "$W/drive_c/Game" "$W/dosdevices" "$F/Elsewhere"
cp "$PE/bmp24.exe" "$W/drive_c/Game/game.exe"
cp "$PE/bmp8.exe" "$F/Elsewhere/other.exe"
ln -s ../drive_c "$W/dosdevices/c:"
ln -s "$F/Elsewhere" "$W/dosdevices/d:"
mkdir -p "$F/.wine/drive_c"

# --- AppImage
mkdir -p "$F/Applications"
printf 'not really an appimage' > "$F/Applications/Foo-1.0.AppImage"
echo fixture-ok
