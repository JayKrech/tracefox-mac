#!/bin/bash
# Kopiert das Developer-ID-Zertifikat aus dem Schluesselbund nach GitHub, Schritt fuer Schritt
# mit normalen Mac-Dialogen. Die geheimen Werte gehen nur ueber die Zwischenablage und werden
# am Ende geloescht.

OPENSSL=/usr/bin/openssl
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/signatur.log"
: > "$LOG"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
WORK=$(mktemp -d) || exit 1
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; pbcopy < /dev/null; }
trap cleanup EXIT

# Dialog mit einem Knopf. Klappt der Dialog nicht, wird im Terminal gefragt.
say() { # Text, Knopf
  local r
  r=$(osascript -e 'on run argv' -e 'display dialog (item 1 of argv) buttons {"Abbrechen", (item 2 of argv)} default button 2 cancel button 1 with title "TraceFox Signatur" with icon note' -e 'end run' "$1" "$2" 2>&1)
  local code=$?
  if [ $code -eq 0 ]; then log "Dialog: $2 geklickt"; return 0; fi
  if echo "$r" | grep -q -- "-128"; then log "Dialog: Abbrechen geklickt"; return 1; fi
  log "Dialog ging nicht ($r), frage im Terminal"
  echo; echo "$1"; echo; read -r -p "Eingabetaste druecken fuer \"$2\" (oder Ctrl+C zum Abbrechen) " _ </dev/tty
  return 0
}
fail() {
  log "FEHLER: $1"
  osascript -e 'on run argv' -e 'display dialog (item 1 of argv) buttons {"OK"} default button 1 with title "TraceFox Signatur" with icon stop' -e 'end run' "$1" >/dev/null 2>&1
  echo; echo "FEHLER: $1"; echo; read -n 1 -s -r -p "Taste druecken zum Schliessen." _ </dev/tty
  exit 1
}
step() { # Nummer, Name, Datei
  pbcopy < "$3"
  log "Schritt $1: $2 in der Zwischenablage ($(wc -c < "$3" | tr -d ' ') Zeichen)"
  say "Schritt $1 von 2
Der Wert fuer $2 liegt jetzt in der Zwischenablage.

ERST in Chrome bei GitHub:
1. ins grosse Feld klicken
2. Cmd+V druecken
3. den gruenen Knopf (Add secret / Update secret) klicken

ERST DANACH hier auf \"Gespeichert\" klicken." "Gespeichert" || { log "abgebrochen bei Schritt $1"; exit 0; }
}

clear
log "TraceFox: Zertifikat zu GitHub. Folge den Dialogen auf dem Bildschirm."
log "macOS $(sw_vers -productVersion 2>/dev/null), openssl: $($OPENSSL version 2>&1)"

# 1. Das Developer-ID-Zertifikat im Schluesselbund finden (auch wenn macOS ihm noch nicht vertraut)
KC="$HOME/Library/Keychains/login.keychain-db"
N=$(security find-certificate -a -c "Developer ID Application" "$KC" 2>/dev/null | grep -c '"labl"')
log "Developer-ID-Zertifikate im Schluesselbund: $N"
security find-identity -p codesigning "$KC" 2>/dev/null | grep "Developer ID" | sed 's/^ *[0-9]*) [0-9A-F]* /  Identitaet: /' | tee -a "$LOG"
[ "$N" -gt 0 ] || fail "Im Schluesselbund ist kein \"Developer ID Application\"-Zertifikat. Bitte Claude Bescheid geben."

say "Gleich fragt macOS nach deinem Mac-Passwort, damit das Zertifikat aus dem Schluesselbund kopiert werden darf.

Gib dein normales Anmeldepasswort ein und klicke \"Erlauben\". Es kann zweimal fragen." "Weiter" || { log "abgebrochen vor dem Export"; exit 0; }

EXPW=$($OPENSSL rand -hex 16)
log "Export aus dem Schluesselbund ..."
security export -k "$KC" -t identities -f pkcs12 -P "$EXPW" -o "$WORK/all.p12" 2>>"$LOG" \
  || fail "Das Zertifikat konnte nicht aus dem Schluesselbund kopiert werden (Passwort abgelehnt?). Starte das Skript einfach noch einmal."

# 2. Nur das Developer-ID-Zertifikat mit seinem Schluessel behalten
$OPENSSL pkcs12 -in "$WORK/all.p12" -passin "pass:$EXPW" -nodes -out "$WORK/all.pem" 2>/dev/null \
  || fail "Die Kopie aus dem Schluesselbund liess sich nicht lesen. Bitte Claude Bescheid geben."
log "Export gelesen ($(grep -c 'BEGIN CERTIFICATE' "$WORK/all.pem") Zertifikate, $(grep -c 'PRIVATE KEY-----' "$WORK/all.pem" | awk '{print $1/2}') Schluessel)"
awk -v d="$WORK" '/-----BEGIN /{n++; f=d"/blk" n ".pem"} f{print > f} /-----END /{close(f); f=""}' "$WORK/all.pem"
CERT="" KEY=""
for f in "$WORK"/blk*.pem; do
  if grep -q "BEGIN CERTIFICATE" "$f" && $OPENSSL x509 -in "$f" -noout -subject 2>/dev/null | grep -q "Developer ID Application"; then CERT="$f"; fi
done
[ -n "$CERT" ] || fail "Im Schluesselbund-Export fehlt das Developer-ID-Zertifikat. Bitte Claude Bescheid geben."
WANT=$($OPENSSL x509 -in "$CERT" -noout -pubkey | $OPENSSL md5)
for f in "$WORK"/blk*.pem; do
  if grep -q "PRIVATE KEY" "$f" && [ "$($OPENSSL pkey -in "$f" -pubout 2>/dev/null | $OPENSSL md5)" = "$WANT" ]; then KEY="$f"; fi
done
[ -n "$KEY" ] || fail "Zum Zertifikat fehlt der private Schluessel. Bitte Claude Bescheid geben."

PW=tracefox   # fixed on purpose, see docs/RELEASING.md
$OPENSSL pkcs12 -export -inkey "$KEY" -in "$CERT" -name "Developer ID Application" -out "$WORK/id.p12" -passout "pass:$PW" 2>/dev/null \
  || fail "Das Zertifikat konnte nicht verpackt werden. Bitte Claude Bescheid geben."
base64 < "$WORK/id.p12" | tr -d '\n' > "$WORK/p12.b64"
log "Zertifikat mit Schluessel verpackt."
rm -f "$WORK"/blk*.pem "$WORK/all.pem" "$WORK/all.p12"

# 3. Der Wert fuer GitHub
step 1 MACOS_CERTIFICATE_P12_BASE64 "$WORK/p12.b64"
pbcopy < /dev/null
say "Schritt 2 von 2: das app-spezifische Passwort

1. Auf account.apple.com (oeffnet sich gleich) anmelden
2. \"Anmeldung und Sicherheit\" > \"App-spezifische Passwoerter\"
3. Ein neues anlegen, Name: TraceFox
4. Das angezeigte Passwort kopieren
5. In Chrome bei GitHub ins Feld \"Secret\" einfuegen (Cmd+V) und \"Add secret\" klicken" "Apple-Seite oeffnen" || { log "abgebrochen bei Schritt 3"; exit 0; }
open "https://account.apple.com/account/manage"
say "Wenn das app-spezifische Passwort bei GitHub gespeichert ist, hier auf \"Fertig\" klicken." "Fertig" || { log "abgebrochen bei Schritt 3"; exit 0; }
log "FERTIG"
osascript -e 'display dialog "Geschafft. Schreib Claude jetzt einfach: fertig" buttons {"OK"} default button 1 with title "TraceFox Signatur" with icon note' >/dev/null 2>&1
