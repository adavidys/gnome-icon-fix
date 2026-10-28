UUID := icon-fix@adavidys
ZIP := dist/$(UUID).shell-extension.zip
SOURCES := $(shell find src -type f ! -name gschemas.compiled) LICENSE

.PHONY: all pack schemas install uninstall clean check

all: pack

# Only needed when running straight from src/ (e.g. a symlinked dev install);
# gnome-extensions pack/install compile the schema themselves.
schemas: src/schemas/gschemas.compiled

src/schemas/gschemas.compiled: src/schemas/*.gschema.xml
	glib-compile-schemas src/schemas

# Zip for https://extensions.gnome.org/upload/
pack: $(ZIP)

$(ZIP): $(SOURCES)
	@mkdir -p dist
	gnome-extensions pack src --force --out-dir=dist \
		--extra-source=split.js \
		--extra-source=debug \
		--extra-source=lib \
		--extra-source=sources \
		--extra-source=mirror \
		--extra-source=qr \
		--extra-source=../LICENSE

# Installs for the current user; log out and back in, then enable it
install: $(ZIP)
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -rf dist src/schemas/gschemas.compiled

# Tests of everything that runs outside GNOME Shell, with code coverage
check:
	sh tests/run.sh

