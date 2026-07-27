# Shared platform shortcuts (Windows: use npm run equivalents)
.PHONY: dev test platform harness ga docker

dev:
	npm run platform:dev

test:
	npm test

platform:
	npm run platform:dev

harness:
	npx tsx -e "import { helloWorldRun } from '@mendpoint/harness'; helloWorldRun().then(r => console.log(r.score))"

ga:
	npm run ga:check

docker:
	docker compose up --build
