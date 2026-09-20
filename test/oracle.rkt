#lang racket/base
;; Development-only differential oracle. Never loaded by the portable product.
(require racket/file racket/list racket/path racket/runtime-path json jev/loader jev/runtime jev/record)
(define-runtime-path examples "../../jev-lang/examples")
(define p (load-jev-policy (build-path examples "ticket-router.rkt")))
(define files
  (append (fixture-paths (build-path examples "fixtures"))
          (fixture-paths (build-path examples "recorded"))))
(write-json
 (for/list ([path (in-list files)])
   (define f (read-fixture path))
   (hasheq 'name (fixture-name f) 'answers (fixture-answers f)
           'decision (decision->jsexpr (fixture-decide p f)))))
