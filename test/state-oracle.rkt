#lang racket/base
(require racket/list racket/runtime-path json jev/state)
(define-runtime-path tests "../../jev-lang/tests")
(define strings '())
(define (walk x)
  (cond [(string? x) (set! strings (cons x strings))]
        [(pair? x) (walk (car x)) (walk (cdr x))]
        [else (void)]))
(for ([file '("redaction-test.rkt" "state-test.rkt")])
  (walk (syntax->datum
         (parameterize ([read-accept-reader #t])
           (call-with-input-file (build-path tests file)
             (lambda (in) (read-syntax file in)))))))
(define specs (cons (redactor-names) (map list (redactor-names))))
(define strings-results
  (for*/list ([s (remove-duplicates strings)] [spec specs])
    (hasheq 'value s 'specs (map symbol->string spec) 'expected (redact-string s spec))))
(define values
  (list (hasheq 'card 4111111111111111 'ssn 123456789 'phone 4155550132)
        (hasheq 'bytes 5368709120 'amount 249.99 'ratio 0.30000000000000004 'order-id 4155550132)
        (hasheq '|jane@example.com| 1 '|bob@example.com| 2 '|<email>| 3
                'nested (hasheq '|10.0.0.1| "up"))
        (hasheq 'password "small" 'token 123 'version "1.2.3.4" 'messages '("call 4155550132" "order 4155550132"))))
(write-json
 (hasheq 'strings strings-results
         'values (for*/list ([v values] [spec specs])
                   (hasheq 'value v 'specs (map symbol->string spec) 'expected (redact-jsexpr v spec)))
         'caps (for*/list ([v (list (make-string 500 #\x)
                                   (hasheq 'long (make-string 600 #\x) 'short "keep me" 'n 42)
                                   (build-list 50 (lambda (i) (format "event number ~a happened" i))))]
                          [cap '(80 150 250)])
                 (hasheq 'value v 'limit cap
                         'expected (hash-ref (build-state-payload (list (cons 'value v)) '() #f
                                                                  #:caps (list cap)) 'value)))))
