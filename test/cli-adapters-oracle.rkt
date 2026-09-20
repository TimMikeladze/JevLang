#lang racket/base
;; Development-only differential oracle for the Claude, Codex and fx CLI
;; adapters: the command line each one builds, and what it makes of the answer.
;; A fake runner stands in for the CLI, so nothing is installed or called.
(require racket/list racket/runtime-path racket/string racket/file racket/port json provider)
(define-runtime-path cases-path "parity/cli-adapter-scenarios.json")
(define cases (call-with-input-file cases-path read-json))
(define directory (vector-ref (current-command-line-arguments) 0))

(define (opt v [default #f]) (if (eq? v 'null) default v))
(define (syms xs) (for/list ([x (in-list xs)]) (string->symbol x)))

(define (scenario-request s)
  (define r (hash-ref s 'request))
  (make-provider-request
   (string->symbol (hash-ref r 'operation))
   (string->symbol (hash-ref r 'mode))
   #:permissions (syms (hash-ref r 'permissions '("read")))
   #:prompt (hash-ref r 'prompt "")
   #:schema (opt (hash-ref r 'schema 'null))
   #:directory (and (opt (hash-ref r 'directory 'null)) directory)
   #:limits (hash-ref r 'limits (hasheq))
   #:metadata (hash-ref r 'metadata (hasheq))))

(define (scenario-target s provider-value)
  (resolved-target provider-value (opt (hash-ref s 'model 'null))
                   (opt (hash-ref s 'effort 'null)) (opt (hash-ref s 'effort 'null))
                   (hasheq 'provider 'request)))

;; The fake CLI: it records the call and answers with the scenario's output.
(define (fake-runner s)
  (lambda (exe args #:stdin [stdin ""] #:timeout [timeout 300] #:dir [dir #f] #:env [env #f] #:on-line [on-line #f])
    (define result (opt (hash-ref s 'result 'null)))
    ;; Codex reads its answer from the file it was told to write.
    (when result
      (let loop ([rest args])
        (cond [(null? rest) (void)]
              [(equal? (car rest) "--output-last-message")
               (call-with-output-file (cadr rest) #:exists 'truncate
                 (lambda (out) (write-json result out)))]
              [else (loop (cdr rest))])))
    (set-box! captured (hasheq 'args args 'stdin stdin 'timeout timeout))
    (values (hash-ref s 'status 0) (hash-ref s 'stdout "") "")))

(define captured (box #f))

(define (runner-for s)
  (case (hash-ref s 'provider)
    [("claude") (lambda (request target) (claude-cli-runner "claude" request target))]
    [("codex") (lambda (request target) (codex-cli-runner "codex" request target #:billing 'subscription))]
    [("fx") (lambda (request target) (fx-cli-runner "fx" request target #:billing 'subscription))]))

(define (provider-for s)
  (case (hash-ref s 'provider)
    [("claude") (claude-provider)] [("codex") (codex-provider)] [("fx") (fx-provider)]))

(define (result->jsexpr r)
  (hasheq 'output (provider-result-output r)
          'model (or (provider-result-model r) 'null)
          'usage (provider-result-usage r)
          'cost (hasheq 'mode (symbol->string (provider-cost-mode (provider-result-cost r)))
                        'usd (or (provider-cost-usd (provider-result-cost r)) 'null))
          'request_id (or (provider-result-request-id r) 'null)
          'exit_status (or (provider-result-exit-status r) 'null)
          'changed (provider-result-changed r)))

;; Absolute paths differ per run, so the recorded command line names them by role.
(define (scrub args)
  (for/list ([a (in-list args)])
    (cond
      [(not (string? a)) a]
      [(or (string=? a directory) (string=? a (string-append directory "/"))) "<dir>"]
      [(regexp-match? #rx"schema[.]json$" a) "<schema>"]
      [(regexp-match? #rx"result[.]json$" a) "<result>"]
      [else a])))

(write-json
 (for/list ([s (in-list (hash-ref cases 'scenarios))])
   (set-box! captured #f)
   (define value (provider-for s))
   (define request (scenario-request s))
   (define target (scenario-target s value))
   (define answer
     (parameterize ([current-program-runner (fake-runner s)])
       (with-handlers ([exn:fail:provider?
                        (lambda (e) (hasheq 'error (hasheq 'kind (format "~a" (exn:fail:provider-kind e))
                                                           'message (exn-message e)
                                                           'retryable (and (exn:fail:provider-retryable? e) #t)
                                                           'mutated (and (exn:fail:provider-mutated? e) #t)
                                                           'status (or (exn:fail:provider-status e) 'null)
                                                           'cost (hasheq 'mode (symbol->string (provider-cost-mode (exn:fail:provider-cost e)))
                                                                         'usd (or (provider-cost-usd (exn:fail:provider-cost e)) 'null)))))]
                       [exn:fail? (lambda (e) (hasheq 'error (hasheq 'kind "raised" 'message (exn-message e))))])
         (hasheq 'result (result->jsexpr ((runner-for s) request target))))))
   (hasheq 'name (hash-ref s 'name)
           'call (let ([c (unbox captured)])
                   (if c (hasheq 'args (scrub (hash-ref c 'args)) 'stdin (hash-ref c 'stdin)
                                 'timeout (hash-ref c 'timeout))
                       'null))
           'answer answer)))
