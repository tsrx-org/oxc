export function Branch(props: { n: number }) @{
	const d = get()
	@if (props.n) {
		<span>{d}</span>
	} @else {
		<span>fallback</span>
	}
}

export function Loop(props: { items: string[] }) @{
	const label = get()
	@for (const x of props.items) {
		<i>
			{label}
			{x}
		</i>
	}
}

export function Pick(props: { n: number }) @{
	const label = get()
	@switch (props.n) {
		@case 1: {
			<b>{label}</b>
		}
	}
}

export function Hazards() @{
	const a = get()
	;[a].forEach(use)
	;(a as number).toFixed()
	<p>{a}</p>
}

function get() {
	return 'x'
}
