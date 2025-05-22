import dotenv from "dotenv";
import createServer from "./createServer.js";
import colors from "colors";
import os from 'os';

dotenv.config();

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            const { address, family, internal } = iface;
            if (family === 'IPv4' && !internal) {
                return address;
            }
        }
    }
    return '127.0.0.1';
}

const localIp = getLocalIpAddress();
const host = "0.0.0.0";
const port = 8082;
const web_server_url = process.env.PUBLIC_URL || `http://${localIp}:${port}`;

export default function server() {
  createServer({
    originBlacklist: [],
    originWhitelist: ['*'],
    requireHeader: [],
    removeHeaders: [
      "cookie",
      "cookie2",
      "x-request-start",
      "x-request-id",
      "via",
      "connect-time",
      "total-route-time",
    ],
    redirectSameOrigin: true,
    httpProxyOptions: {
      xfwd: false,
    },
  }).listen(port, Number(host), function () {
    console.log(
      colors.green("Server running on ") + colors.blue(`${web_server_url}`)
    );
  });
}
