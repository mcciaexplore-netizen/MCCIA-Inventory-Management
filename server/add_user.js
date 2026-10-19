// Usage: node add_user.js "<name>" <email> <password> <admin|employee|staff> "<office>"
// Uses DATABASE_URL if set, otherwise the local sample database.
import { db, hashPassword, OFFICES } from './db.js';

const [name, email, password, role = 'staff', office = 'Head Office'] = process.argv.slice(2);
if (!name || !email || !password || password.length < 6) { console.error('Usage: node add_user.js "<name>" <email> <password (6+ chars)> <role> "<office>"'); process.exit(1); }
if (!['admin', 'employee', 'staff'].includes(role)) { console.error('Role must be admin, employee or staff'); process.exit(1); }
if (!OFFICES.includes(office)) { console.error(`Office must be one of: ${OFFICES.join(', ')}`); process.exit(1); }

await db.run('INSERT INTO users (name,email,password_hash,role,office) VALUES (?,?,?,?,?)', [name, email.toLowerCase(), hashPassword(password), role, office]);
console.log(`Created ${role} ${email.toLowerCase()} (${office})`);
process.exit(0);
