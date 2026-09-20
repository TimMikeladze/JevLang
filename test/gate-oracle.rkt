#lang racket/base
;; Development-only differential oracle for the gate: the verdict a tool call
;; gets, the hook's answer for each host, and the pure helpers around them.
(require racket/list racket/string racket/runtime-path json
         jev/loader jev/runtime jev/client jev/gate jev/record)
(define-runtime-path examples "../../jev-lang/examples")
(define-runtime-path fixtures "../../jev-lang/examples/gate-fixtures")
(define approvals (vector-ref (current-command-line-arguments) 0))
(define p (load-jev-policy (build-path examples "tool-gate.rkt")))

(define cases
  (sort (for/list ([path (in-list (fixture-paths fixtures))])
          (define f (read-fixture path))
          (cons (fixture-name f) f))
        string<? #:key car))

;; Every call is answered from the fixture whose state matches the request.
(define (transport-for answers)
  (lambda (payload) (hasheq 'answers answers 'model "jev-1.13.0" 'usage (hasheq 'input_tokens 10))))

(define (verdict->jsexpr v)
  (hasheq 'verdict (symbol->string (gate-verdict-verdict v))
          'by (symbol->string (gate-verdict-by v))
          'reason (gate-verdict-reason v)))

(define (check-one f #:allow [allow '()] #:deny [deny '()] #:on-error [on-error 'ask])
  (define g (make-gate p #:allow allow #:deny deny #:on-error on-error))
  (parameterize ([current-jev-transport (transport-for (fixture-answers f))]
                 [current-api-key "test-key"])
    (verdict->jsexpr (gate-check g (fixture-state f)))))

(define (hook-for f host)
  (define g (make-gate p))
  (define state (fixture-state f))
  (define input
    (hasheq 'hook_event_name "PreToolUse"
            'tool_name (hash-ref state 'tool)
            'tool_input (hash-ref state 'arguments)
            'cwd (path->string (current-directory))
            'session_id "s1"
            'model (if (eq? host 'codex) "gpt-6" 'null)))
  (parameterize ([current-jev-transport (transport-for (fixture-answers f))]
                 [current-api-key "test-key"]
                 [current-gate-approval-directory (string->path approvals)])
    (define out (hook-response input (lambda () g) #:host host))
    (hasheq 'output (or out 'null)
            'fingerprint (call-fingerprint input (gate-policy-hash g)))))

(define decisions
  (list (hasheq 'action "assign" 'target "allow" 'reason "it only reads")
        (hasheq 'action "escalate" 'target "ask" 'reason "it destroys data")
        (hasheq 'action "page" 'target "deny" 'reason "no")
        (hasheq 'action "hold" 'target 'null 'reason "unsure")
        (hasheq 'action "confirm" 'target "unlock" 'reason "needs a person")
        (hasheq 'action "assign" 'target "billing-queue" 'reason "wrong target")
        (hasheq 'action "next" 'target "stage-2" 'reason 'null)))

(define hook-event
  (hasheq 'hook_event_name "PreToolUse" 'tool_name "  Bash  "
          'tool_input (hasheq 'command "rm -rf build")
          'cwd (path->string (current-directory)) 'session_id "s1"))

(write-json
 (hasheq
  'verdicts (for/list ([c (in-list cases)])
              (hasheq 'name (car c) 'verdict (check-one (cdr c))))
  'lists (list (check-one (cdr (assoc "read-readme" cases)) #:deny '("Read"))
               (check-one (cdr (assoc "rm-build" cases)) #:allow '("Ba*"))
               (check-one (cdr (assoc "rm-build" cases)) #:deny '("mcp__*" "Bash")))
  'hooks (for/list ([c (in-list cases)])
           (hasheq 'name (car c)
                   'claude (hook-for (cdr c) 'claude)
                   'codex (hook-for (cdr c) 'codex)))
  'verdict-mapping (for/list ([d (in-list decisions)])
                     (define-values (v reason) (decision->verdict (jsexpr->decision d)))
                     (hasheq 'verdict (symbol->string v) 'reason reason))
  'matches (list (tool-matches? '("Bash") "Bash")
                 (tool-matches? '("mcp__*") "mcp__home__lock_door")
                 (tool-matches? '("*write*") "WriteFile")
                 (tool-matches? '("Bash") "bash")
                 (tool-matches? '() "Bash"))
  'parsed (parse-tool-list " Bash, mcp__* ,, Read ")
  'digest (call-digest "Bash" (hasheq 'command "rm -rf build"))
  'server-of (list (or (mcp-server-of-tool "mcp__home__lock_door") 'null)
                   (or (mcp-server-of-tool "Bash") 'null))
  'normalized (let ([e (normalize-hook-event hook-event)])
                (hash-set e 'host (symbol->string (hash-ref e 'host))))
  'fingerprint (call-fingerprint hook-event "abc")
  'outputs (for*/list ([host '(claude codex)] [v '(allow deny ask)])
             (hook-output v "because" #:host host))))
