-- Explicit owner-requested note append. The caller supplies the value locally;
-- emit fixed statuses only, including on failure. Never replace existing notes.
on run argv
  try
    if (count of argv) is not 2 then return "invalid_arguments"
    set contactName to item 1 of argv
    set noteLine to item 2 of argv
    if noteLine is "" then return "empty_note"
    tell application "Contacts"
      set candidates to every person whose name is contactName
      if (count of candidates) is not 1 then return "ambiguous_contact"
      set personRecord to item 1 of candidates
      set oldNote to note of personRecord
      if oldNote is missing value then set oldNote to ""
      if oldNote contains noteLine then return "already_present"
      if oldNote is "" then
        set note of personRecord to noteLine
      else
        set note of personRecord to oldNote & linefeed & noteLine
      end if
      save
      if (note of personRecord) contains noteLine then return "saved_and_verified"
      return "verification_failed"
    end tell
  on error
    return "contacts_action_failed"
  end try
end run
