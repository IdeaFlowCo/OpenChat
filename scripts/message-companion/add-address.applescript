-- Explicit CLI action. Append one supplied street address; preserve every other
-- contact field. Contacts.app owns authorization and account synchronization.
on run argv
  if (count of argv) is not 2 then error "Expected contact name and street"
  set contactName to item 1 of argv
  set streetValue to item 2 of argv
  if streetValue is "" then error "Street is empty"
  tell application "Contacts"
    set candidates to every person whose name is contactName
    if (count of candidates) is not 1 then return "ambiguous_contact"
    set personRecord to item 1 of candidates
    repeat with a in addresses of personRecord
      if (street of a as text) is streetValue then return "already_present"
    end repeat
    make new address at end of addresses of personRecord with properties {street:streetValue, label:"shared in iMessage"}
    save
    repeat with a in addresses of personRecord
      if (street of a as text) is streetValue then return "saved_and_verified"
    end repeat
    return "verification_failed"
  end tell
end run
