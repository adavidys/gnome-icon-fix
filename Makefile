UUID := icon-fix@adavidys
ZIP := dist/$(UUID).shell-extension.zip
SOURCES := $(shell find src -type f) LICENSE

.PHONY: all pack install uninstall clean

all: pack

# Zip for https://extensions.gnome.org/upload/
pack: $(ZIP)

$(ZIP): $(SOURCES)
	@mkdir -p dist
	gnome-extensions pack src --force --out-dir=dist \
		--extra-source=matcher.js \
		--extra-source=qr \
		--extra-source=../LICENSE

# Installs for the current user; log out and back in, then enable it
install: $(ZIP)
	gnome-extensions install --force $(ZIP)

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -rf dist
