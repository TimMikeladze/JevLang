#lang racket/base
;; Development-only differential oracle for the custom executable protocol: the
;; same fake provider, run by the Racket implementation, so the wire request and
;; the result mapping can be compared with the portable engine's.
(require racket/list json provider)

(define script (vector-ref (current-command-line-arguments) 0))
(define directory (vector-ref (current-command-line-arguments) 1))

(define p
  (command-provider 'fake script
                    #:capabilities (provider-capabilities '(structured workspace) '(text) '(read write)
                                                          '(structured-output tool-policy) '("low" "high") 1)
                    #:environment '("ALLOWED")
                    #:timeout 30))
(define registry (make-provider-registry))
(void (register-provider! registry p))

(define request
  (make-provider-request 'review 'workspace
                         #:role 'audit #:kind 'diff #:tier 'deep
                         #:permissions '(read write)
                         #:prompt "look at this"
                         #:schema (hasheq 'type "object")
                         #:images (list "/tmp/a.png")
                         #:directory directory
                         #:limits (hasheq 'timeout_seconds 30)
                         #:metadata (hasheq 'disallowed '("Bash"))))
(define config (merge-provider-config #:project (hasheq 'provider "fake" 'model "fake-1" 'effort "high")))
(define result (run-provider-request request config registry))

(write-json
 (hasheq 'wire (hash-ref (provider-result-output result) 'request)
         'result (hasheq 'model (or (provider-result-model result) 'null)
                         'usage (provider-result-usage result)
                         'cost (hasheq 'mode (symbol->string (provider-cost-mode (provider-result-cost result)))
                                       'usd (or (provider-cost-usd (provider-result-cost result)) 'null))
                         'request_id (or (provider-result-request-id result) 'null)
                         'exit_status (or (provider-result-exit-status result) 'null)
                         'changed (provider-result-changed result)
                         'attempts (for/list ([a (in-list (provider-result-attempts result))])
                                     (symbol->string (provider-attempt-outcome a))))))
