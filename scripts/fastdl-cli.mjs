import fs from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';

async function downloadFastDL(url) {
    if (!url) {
        console.error("Please provide a URL to download.");
        process.exit(1);
    }
    
    console.log("Fetching video from FastDL URL...");
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
        }
        
        const timestamp = Date.now();
        const dest = path.join(process.cwd(), `instagram-video-${timestamp}.mp4`);
        const fileStream = fs.createWriteStream(dest);
        
        console.log(`Downloading to ${dest}...`);
        await pipeline(response.body, fileStream);
        console.log("Download complete! \u2705");
        
    } catch (e) {
        console.error("Error downloading:", e.message);
    }
}

const urlArg = process.argv[2];
downloadFastDL(urlArg);
