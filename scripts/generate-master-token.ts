import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const clientId = process.env.GOOGLE_MASTER_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_MASTER_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

if (!clientId || !clientSecret) {
  console.error('❌ Error: GOOGLE_MASTER_CLIENT_ID and GOOGLE_MASTER_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
});

console.log('\n' + '═'.repeat(70));
console.log('🔑 GOOGLE MASTER DRIVE 2TB OAUTH REFRESH TOKEN GENERATOR');
console.log('═'.repeat(70));
console.log('\n👉 1. Open the following URL in your browser:\n');
console.log(authUrl);
console.log('\n👉 2. Sign in with your 2TB Google Drive account and click "Allow".');
console.log('👉 3. After authorising, Google will redirect you to:');
console.log('      http://localhost:3001/api/auth/google/callback?code=XXXXX');
console.log('👉 4. Copy the "code" query parameter value from the URL (or full redirect URL) and paste it below:\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Paste Code or Redirect URL here: ', async (input) => {
  rl.close();
  let code = input.trim();
  if (code.includes('code=')) {
    const match = code.match(/code=([^&]+)/);
    if (match) code = decodeURIComponent(match[1]);
  }

  try {
    console.log('\n⏳ Exchanging authorization code for Master Refresh Token...');
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.warn('\n⚠️ No refresh_token returned. This happens if consent prompt was bypassed.');
      console.log('Tokens received:', tokens);
    } else {
      console.log('\n✅ REFRESH TOKEN RECEIVED SUCCESSFULLY:');
      console.log('═'.repeat(70));
      console.log(tokens.refresh_token);
      console.log('═'.repeat(70));

      // Save to .env
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        if (envContent.includes('GOOGLE_MASTER_REFRESH_TOKEN=')) {
          envContent = envContent.replace(
            /GOOGLE_MASTER_REFRESH_TOKEN=.*/,
            `GOOGLE_MASTER_REFRESH_TOKEN=${tokens.refresh_token}`
          );
        } else {
          envContent += `\nGOOGLE_MASTER_REFRESH_TOKEN=${tokens.refresh_token}\n`;
        }
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log(`\n💾 Saved GOOGLE_MASTER_REFRESH_TOKEN directly to backend/.env!`);
      }
    }
  } catch (err: any) {
    console.error('\n❌ Token exchange failed:', err.message || err);
  }
});
