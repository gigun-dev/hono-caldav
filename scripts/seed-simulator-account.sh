#!/bin/bash
# Insert a subscribed calendar into Simulator's Accounts3.sqlite
# so that Settings > Calendar shows "Calendar Accounts" section.
# This avoids navigating the "choose from a list." link which is
# unreliable in CI (Maestro can't tap UITextView links on GitHub Actions).
#
# Usage: ./scripts/seed-simulator-account.sh <path-to-Accounts3.sqlite>

set -euo pipefail

DB="$1"
if [ ! -f "$DB" ]; then
  echo "ERROR: Accounts3.sqlite not found: $DB" >&2
  exit 1
fi

# SubscribedCalendar account type (com.apple.account.SubscribedCalendar)
SUB_CAL_TYPE=$(sqlite3 "$DB" "SELECT Z_PK FROM ZACCOUNTTYPE WHERE ZIDENTIFIER='com.apple.account.SubscribedCalendar';")
if [ -z "$SUB_CAL_TYPE" ]; then
  echo "ERROR: SubscribedCalendar account type not found" >&2
  exit 1
fi

UUID=$(uuidgen)

sqlite3 "$DB" "
INSERT INTO ZACCOUNT (Z_ENT, Z_OPT, ZACTIVE, ZAUTHENTICATED, ZSUPPORTSAUTHENTICATION,
  ZVISIBLE, ZWARMINGUP, ZACCOUNTTYPE, ZACCOUNTDESCRIPTION, ZIDENTIFIER,
  ZOWNINGBUNDLEID, ZUSERNAME)
VALUES (2, 1, 1, 1, 1, 1, 0, $SUB_CAL_TYPE, 'E2E Dummy', '$UUID', 'com.apple.Preferences', '');
"

echo "Simulator account seeded (SubscribedCalendar: $UUID)"
