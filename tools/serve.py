"""Static preview server that refuses to let the browser reuse a stale file.

python3 -m http.server lets browsers heuristically cache JS and CSS, so after an
edit a reload can pair an old script with new HTML and blow up on a missing
element. Sending no-store keeps the preview always in step with the files.
"""
import functools
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, *args):
        pass


# The page asks for thirty-odd sprite strips at once and browsers open several
# sockets in parallel. A plain TCPServer handles one connection at a time with a
# listen backlog of five, so the extra connections are refused and whichever image
# loses the race reports "failed to load". Serving each request on its own thread,
# with a generous backlog, keeps every strip in the page.
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128


with Server(('0.0.0.0', PORT), functools.partial(Handler, directory='.')) as httpd:
    print(f'serving {PORT}', flush=True)
    httpd.serve_forever()
