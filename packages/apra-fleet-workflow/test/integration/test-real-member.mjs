import { McpClient } from './lib/fleet-client/client.mjs';
import { StreamableHttpTransport } from './lib/fleet-client/transport.mjs';
import { ApraFleet } from './lib/fleet-client/api.mjs';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    console.log('Connecting to real apra-fleet server at http://127.0.0.1:7523/mcp...');
    const transport = new StreamableHttpTransport('http://127.0.0.1:7523/mcp');
    const readyPromise = new Promise(resolve => transport.on('ready', resolve));
    transport.start();
    await readyPromise;
    console.log('Connected!');

    const client = new McpClient(transport);
    const fleet = new ApraFleet(client);

    // 1. Create a dummy file
    const dummyFile = 'dummy-send-file.txt';
    fs.writeFileSync(dummyFile, 'Hello from sendFiles wrapper test!');

    console.log('Testing sendFiles to apra-pm...');
    const sendOptions = {
        local_paths: [path.resolve(dummyFile)],
        dest_subdir: 'test-uploads',
        member_name: 'apra-pm'
    };
    const sendResult = await fleet.sendFiles(sendOptions);
    console.log('sendFiles Result:', sendResult);

    console.log('Testing receiveFiles from apra-pm...');
    const receiveOptions = {
        remote_paths: ['test-uploads/dummy-send-file.txt'],
        local_dest_dir: path.resolve('test-downloads'),
        member_name: 'apra-pm'
    };
    
    // Ensure download dir exists
    if (!fs.existsSync(receiveOptions.local_dest_dir)) {
        fs.mkdirSync(receiveOptions.local_dest_dir);
    }

    const receiveResult = await fleet.receiveFiles(receiveOptions);
    console.log('receiveFiles Result:', receiveResult);
    
    const downloadedContent = fs.readFileSync(path.join(receiveOptions.local_dest_dir, 'dummy-send-file.txt'), 'utf-8');
    console.log('Downloaded Content:', downloadedContent);

    transport.stop();
}

main().catch(console.error);
