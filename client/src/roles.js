// Display names only — the stored role values ('staff', 'employee', 'admin') are unchanged.
// What the app stores as 'staff' is shown to users as "Employee" (request-only access), and what
// it stores as 'employee' is shown as "Staff" (full inventory management access).
const ROLE_LABELS = { staff: 'Employee', employee: 'Staff', admin: 'Admin' };

export const roleLabel = (role) => ROLE_LABELS[role] || role;
