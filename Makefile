UUID := icon-fix@adavidys
ZIP := dist/$(UUID).shell-extension.zip

# Everything in src/ that gnome-extensions pack leaves out by default (it
# takes extension.js, prefs.js, metadata.json and the schemas itself).
EXTRA := $(filter-out extension.js prefs.js metadata.json schemas,$(notdir $(wildcard src/*)))

.PHONY: all pack schemas install uninstall clean check

all: pack

# Zip for https://extensions.gnome.org/upload/; built anew each time,
# replacing the one in dist/.
pack:
	@mkdir -p dist
	gnome-extensions pack src --force --out-dir=dist \
		$(addprefix --extra-source=,$(EXTRA)) --extra-source=../LICENSE

# Installs for the current user; log out and back in, then enable it.
install: pack
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

# Only needed when running straight from src/ (e.g. a symlinked dev install);
# gnome-extensions pack/install compile the schema themselves.
schemas: src/schemas/gschemas.compiled

src/schemas/gschemas.compiled: $(wildcard src/schemas/*.gschema.xml)
	glib-compile-schemas src/schemas

clean:
	rm -rf dist src/schemas/gschemas.compiled

# Tests of everything that runs outside GNOME Shell, with code coverage.
check:
	sh tests/run.sh
