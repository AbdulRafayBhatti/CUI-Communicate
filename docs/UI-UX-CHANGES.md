# UI/UX corrections (client only)

Files changed: `client/src/App.jsx`, `client/src/main.jsx`, `client/src/styles.css`. No server code, API contract, Socket.IO event, or authorization rule was changed.

- **Administration crash fixed**: the Create-account role dropdown referenced an undefined variable (`u`), which unmounted the app. Now uses the assignable-roles list.
- **Error boundary** (`main.jsx`): a render error shows a recoverable screen instead of a blank page.
- **Navigation**: duplicate sidebar entries removed; MANAGE section; readable labels/breadcrumbs; correct active state (including inside a group chat).
- **User menu** replaces click-to-sign-out chip; Ctrl/⌘+K focuses search; Esc / outside-click close popovers.
- **Create account**: department disabled for Campus Incharge (campus-wide role); form resets role.
- **Messaging**: live refresh of the open conversation (Accept/Decline/Block take effect immediately); declined/blocked/pending banners and list tags; Block/Unblock menu; write-your-own first message with live user search; day dividers; honest single "sent" tick; error-styled toasts; removed dead paperclip.
- **Mobile**: Back button from an open chat to the conversation list.
- **Group chat**: correct back arrow, day dividers, accessible labels.

Known server-side issues NOT addressed here: `/api/health` requires auth; removing a member from a default group is undone on their next `/groups` load; reseeding hides prior group history.
