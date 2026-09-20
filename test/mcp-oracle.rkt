#lang racket/base
;; Development-only differential oracle for the MCP server: the same messages,
;; answered by the Racket implementation's pure handler.
(require racket/list racket/runtime-path json jev/loader jev/mcp)
(define-runtime-path examples "../../jev-lang/examples")
(define-runtime-path session "../../jev-lang/examples/mcp-session.jsonl")
(define p (load-jev-policy (build-path examples "ticket-router.rkt")))
(define server (policy->mcp-server p))
(define conn (make-mcp-conn))

(define extra
  (list
   ;; a modern request with no client capabilities
   (hasheq 'jsonrpc "2.0" 'id 10 'method "tools/list"
           'params (hasheq '_meta (hasheq (string->symbol "io.modelcontextprotocol/protocolVersion") "2026-07-28")))
   ;; an unknown protocol version
   (hasheq 'jsonrpc "2.0" 'id 11 'method "ping"
           'params (hasheq '_meta (hasheq (string->symbol "io.modelcontextprotocol/protocolVersion") "1999-01-01"
                                          (string->symbol "io.modelcontextprotocol/clientCapabilities") (hasheq))))
   ;; an unknown method, and an unknown tool
   (hasheq 'jsonrpc "2.0" 'id 12 'method "nonsense/method" 'params (hasheq))
   (hasheq 'jsonrpc "2.0" 'id 13 'method "tools/call" 'params (hasheq 'name "nope" 'arguments (hasheq)))
   ;; a resource, and one that does not exist
   (hasheq 'jsonrpc "2.0" 'id 14 'method "resources/list" 'params (hasheq))
   (hasheq 'jsonrpc "2.0" 'id 15 'method "resources/read" 'params (hasheq 'uri "jev://policy/actions"))
   (hasheq 'jsonrpc "2.0" 'id 16 'method "resources/read" 'params (hasheq 'uri "jev://nowhere"))
   ;; a cursor nobody issued, and a bad id
   (hasheq 'jsonrpc "2.0" 'id 17 'method "tools/list" 'params (hasheq 'cursor "abc"))
   (hasheq 'jsonrpc "2.0" 'id (hasheq 'bad #t) 'method "ping" 'params (hasheq))
   ;; a notification needs no reply
   (hasheq 'jsonrpc "2.0" 'method "notifications/cancelled" 'params (hasheq))))

(define messages
  (append (for/list ([line (in-lines (open-input-file session))]
                     #:unless (equal? (string-trim line) ""))
            (string->jsexpr line))
          extra))
(require racket/string)

(write-json
 (for/list ([msg (in-list messages)])
   (define reply (mcp-handle-message server msg conn))
   (hasheq 'reply (or reply 'null))))
