#lang racket/base
;; Development-only differential oracle for cascade dispatch: the same scenarios
;; the portable dispatcher runs, dispatched by the Racket implementation against
;; the smart-home policy's action declarations.
(require racket/list racket/runtime-path json jev/loader jev/runtime jev/cascade)
(define-runtime-path examples "../../jev-lang/examples")
(define-runtime-path scenarios-path "parity/dispatch-scenarios.json")
(define home (load-jev-policy (build-path examples "smart-home.rkt")))

(define (opt h k [default #f]) (let ([v (hash-ref h k default)]) (if (eq? v 'null) default v)))

;; A handler built from data: "ok", "decline", {"raise": message},
;; {"decide": decision}, {"chain": [behaviour ...]}.
(define (behaviour->handler b)
  (cond
    [(equal? b "ok") (lambda (state d) "ok")]
    [(equal? b "decline") (lambda (state d) #f)]
    [(and (hash? b) (hash-ref b 'raise #f)) => (lambda (m) (lambda (state d) (raise (exn:fail m (current-continuation-marks)))))]
    [(and (hash? b) (hash-ref b 'decide #f)) => (lambda (j) (lambda (state d) (jsexpr->decision j)))]
    [(and (hash? b) (hash-ref b 'chain #f))
     => (lambda (links) (apply handler-chain (map behaviour->handler links)))]
    [else (error 'oracle "unknown behaviour ~e" b)]))

(define (run scenario)
  (define handlers
    (for/hasheq ([(target b) (in-hash (hash-ref scenario 'handlers (hasheq)))])
      (values target (behaviour->handler b))))
  (define guards
    (for/hasheq ([(target allow) (in-hash (hash-ref scenario 'guards (hasheq)))])
      (values target (lambda (state d) (and allow #t)))))
  (define budgets
    (for/list ([b (in-list (hash-ref scenario 'budgets '()))])
      (budget (string->symbol (hash-ref b 'name)) #:max (hash-ref b 'max) #:per (hash-ref b 'per))))
  (define confirm-setting (hash-ref scenario 'confirm 'unset))
  (define d
    (make-dispatcher handlers
                     #:policy home
                     #:default #f
                     #:allow-extra? #t
                     ;; Only the targets this scenario registers, so coverage
                     ;; passes without a default and an unknown target raises.
                     #:policy-targets (hash-keys handlers)
                     #:guards guards
                     #:budgets budgets
                     #:dry-run? (eq? (hash-ref scenario 'dry_run #f) #t)
                     #:plan-failure (string->symbol (hash-ref scenario 'plan_failure "stop"))
                     #:clock (lambda () 1000000)
                     #:confirm (if (eq? confirm-setting 'unset)
                                   (lambda (state d) #t)
                                   (lambda (state d) (eq? confirm-setting #t)))
                     #:auto-run-due? #f))
  (define principal (opt scenario 'principal))
  (define facts (opt scenario 'facts))
  (with-handlers ([exn:fail? (lambda (e) (hasheq 'name (hash-ref scenario 'name) 'error (exn-message e)))])
    (define o (dispatch d (hasheq 'request "the request") (jsexpr->decision (hash-ref scenario 'decision))
                        #:principal principal #:key (opt scenario 'key) #:facts facts))
    (hasheq 'name (hash-ref scenario 'name) 'outcome (outcome->jsexpr o))))

(write-json (for/list ([s (in-list (call-with-input-file scenarios-path read-json))]) (run s)))
