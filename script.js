/**
 * Детский сад 2.0 — клиентская логика.
 * Разметка экранов и фрагментов: index.html. Оформление: style.css.
 * Конфигурация подключения: существующий config.js (window.APP_CONFIG).
 * Серверные правила задач/зон и права доступа остаются в Supabase.
 */

// HTML-шаблоны хранятся в index.html как неисполняемые text/html-блоки.
// Это сохраняет фрагменты <tr>/<td>/<option> без исправлений HTML-парсером.
const templateCache = new Map();
function renderTemplate(id, values = {}) {
	if (!templateCache.has(id)) {
		const source = document.getElementById(id);
		if (!source || source.type !== 'text/html') throw new Error('Не найден HTML-шаблон: ' + id);
		templateCache.set(id, source.textContent);
	}
	// Значения вставляются за один проход: {{...}} внутри пользовательского текста
	// не обрабатываются повторно. Данные должны пройти esc/safe/escape у вызывающего кода;
	// вложенная разметка поступает только из другого renderTemplate.
	return templateCache.get(id).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, key) => {
		if (!Object.prototype.hasOwnProperty.call(values, key))
			throw new Error('Не заполнено поле шаблона ' + id + ': ' + key);
		return String(values[key]);
	});
}

// Общее состояние сессии и выбранного периода.
const $ = (s) => document.querySelector(s);
const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			})[c],
	);
const config = window.APP_CONFIG;
let db,
	me,
	profiles = [],
	periods = [],
	prefs = [],
	assigned = [],
	draft = [],
	dates = [],
	versions = [],
	archiveRows = [],
	draftDirty = false,
	draftExists = false;
let toastTimer;
const notice = (s) => {
	const el = $('#status');
	el.textContent = s;
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.hidden = true;
	}, 4000);
};
const check = (r) => {
	if (r.error) throw r.error;
	return r.data;
};
const dayAdd = (s, n) => {
	const d = new Date(s + 'T12:00:00Z');
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};
const week = (s) => {
	const d = new Date(s + 'T12:00:00Z');
	return dayAdd(s, -((d.getUTCDay() + 6) % 7));
};
const label = (s) =>
	new Date(s + 'T12:00:00Z').toLocaleDateString('ru-RU', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		timeZone: 'UTC',
	});
const bishkekToday = () =>
	new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Bishkek',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date());
const period = () => periods.find((p) => String(p.id) === $('#periodSelect').value);
/* Даты выбранного периода включительно. Даты храним как YYYY-MM-DD. */
function days(p) {
	let a = [];
	for (let d = p.start_date; d <= p.end_date; d = dayAdd(d, 1)) a.push(d);
	return a;
}
/* Пожелание сотрудника на конкретную дату. */
function choice(uid, day) {
	return prefs.find((x) => x.user_id === uid && x.day === day)?.choice;
}
/* Соответствие пожеланий допустимым обозначениям смен. */
function allows(c, s) {
	return (
		{
			morning: ['у'],
			evening: ['в'],
			both: ['у/в'],
			day: ['д'],
			off: [],
		}[c] || []
	).includes(s);
}
/* Проверка доступности сотрудника и недельного лимита для черновика. */
function eligible(uid, d, s, rows) {
	if (!allows(choice(uid, d), s)) return false;
	if (rows.some((x) => x.user_id === uid && x.day === d)) return false;
	return rows.filter((x) => x.user_id === uid && week(x.day) === week(d)).length < 5;
}
/* Подсчёт утреннего и вечернего состава: Д и У/В учитываются в обоих. */
function coverage(rows, d) {
	let x = rows.filter((r) => r.day === d);
	return {
		u: x.filter((r) => ['у', 'у/в', 'д'].includes(r.shift)).length,
		v: x.filter((r) => ['в', 'у/в', 'д'].includes(r.shift)).length,
	};
}
/* Требуемое количество сотрудников в будни и выходные. */
function target(d) {
	let k = new Date(d + 'T12:00:00Z').getUTCDay();
	return {
		u: k === 0 || k === 6 ? 5 : 4,
		v: 4,
	};
}
/* Предупреждения к графику перед сохранением и публикацией. */
function issues(rows) {
	let all = [...assigned.filter((x) => !dates.includes(x.day)), ...rows],
		problems = [];
	let missing = profiles.filter((p) => p.role === 'staff' && dates.some((d) => !choice(p.id, d)));
	if (missing.length)
		problems.push('Не все дни заполнены: ' + missing.map((p) => p.name).join(', '));
	for (let d of dates) {
		let c = coverage(rows, d),
			t = target(d);
		if (c.u < t.u || c.v < t.v)
			problems.push(
				`${label(d)}: не хватает утром ${Math.max(0, t.u - c.u)}, вечером ${Math.max(0, t.v - c.v)}`,
			);
	}
	for (let x of rows) {
		let n = profiles.find((p) => p.id === x.user_id)?.name || 'Сотрудник';
		if (choice(x.user_id, x.day) && !allows(choice(x.user_id, x.day), x.shift))
			problems.push(`${n}, ${label(x.day)}: смена не соответствует доступности`);
		if (all.filter((a) => a.user_id === x.user_id && week(a.day) === week(x.day)).length > 5)
			problems.push(`${n}, неделя с ${label(week(x.day))}: менее двух выходных`);
	}
	return [...new Set(problems)];
}
let availabilityDirty = false;
/* Форма пожеланий: заполнение, блокировка и взаимоисключение Д / У+В. */
function renderAvailability() {
	$('#availability').hidden = !(me?.role === 'staff' && period()?.requests_open);
	const el = $('#availabilityGrid');
	if (!period()) {
		el.innerHTML = renderTemplate('tpl-render-availability-p');
		$('#saveAvailability').disabled = true;
		return;
	}
	let locked = !period().requests_open && me.role !== 'admin';
	let submitted = dates.length > 0 && dates.every((d) => !!choice(me.id, d));
	availabilityDirty = false;
	$('#availabilityTitle').textContent = submitted
		? 'Пожелания отправлены'
		: 'Отправить желаемый график';
	$('#requestStatus').textContent = period().requests_open
		? 'Сбор пожеланий открыт.'
		: 'Сбор пожеланий закрыт.';
	$('#saveAvailability').disabled = locked;
	$('#saveAvailability').hidden = submitted || locked;
	el.innerHTML = dates
		.map((d) => {
			let c = choice(me.id, d);
			return renderTemplate('tpl-render-availability-div', {
				date: d,
				dateLabel: label(d),
				choices: [
					['m', 'Утро'],
					['v', 'Вечер'],
					['d', 'День'],
				]
					.map(([v, t]) =>
						renderTemplate('tpl-render-availability-label', {
							shiftCode: v,
							checked:
								(v === 'm' && ['morning', 'both'].includes(c)) ||
								(v === 'v' && ['evening', 'both'].includes(c)) ||
								(v === 'd' && c === 'day')
									? 'checked'
									: '',
							shiftLabel: t,
						}),
					)
					.join(''),
			});
		})
		.join('');
	el.querySelectorAll('input').forEach((input) => {
		input.disabled = locked;
		input.addEventListener('change', () => {
			availabilityDirty = true;
			$('#saveAvailability').hidden = false;
			if (!input.checked) return;
			let row = input.closest('.day');
			if (input.value === 'd') {
				row.querySelectorAll('input').forEach((i) => {
					if (i !== input) i.checked = false;
				});
			} else {
				row.querySelectorAll('input').forEach((i) => {
					if (i.value === 'd') i.checked = false;
				});
			}
		});
	});
}
/* Общий рендер таблицы для опубликованного графика и редактируемого черновика. */
function table(rows, editable = false) {
	rows = rows.filter((x) => profiles.some((p) => p.id === x.user_id && p.role === 'staff'));
	if (!dates.length) return renderTemplate('tpl-table-p');
	return renderTemplate('tpl-table-table', {
		dates: dates
			.map((d) =>
				renderTemplate('tpl-table-th', {
					dateLabel: label(d),
				}),
			)
			.join(''),
		employees: profiles
			.filter((p) => p.role === 'staff')
			.map((p) =>
				renderTemplate('tpl-table-tr', {
					name: esc(p.name),
					days: dates
						.map((d) => {
							let x = rows.find((a) => a.user_id === p.id && a.day === d),
								s = x?.shift || '';
							return renderTemplate('tpl-table-td', {
								cell: editable
									? renderTemplate('tpl-table-button', {
											userId: p.id,
											date: d,
											shiftLabel: s || '—',
										})
									: s
										? renderTemplate('tpl-table-span', {
												shiftClass:
													s === 'у/в'
														? 'full'
														: s === 'у'
															? 'morning'
															: s === 'в'
																? 'evening'
																: 'day',
												shiftLabel: esc(s.toUpperCase()),
											})
										: '—',
							});
						})
						.join(''),
					shiftCount: rows.filter((a) => a.user_id === p.id).length,
					fullDayCount: rows.filter((a) => a.user_id === p.id && a.shift === 'у/в')
						.length,
				}),
			)
			.join(''),
		morningTotals: dates
			.map((d) =>
				renderTemplate('tpl-table-td-2', {
					actual: coverage(rows, d).u,
					required: target(d).u,
				}),
			)
			.join(''),
		eveningTotals: dates
			.map((d) =>
				renderTemplate('tpl-table-td-3', {
					actual: coverage(rows, d).v,
					required: target(d).v,
				}),
			)
			.join(''),
	});
}
/* Предупреждения и редактирование ячеек черновика. */
function renderDraft() {
	let warnings = issues(draft);
	rememberDisclosures($('#draftInfo'));
	$('#draftInfo').innerHTML = warnings.length
		? renderTemplate('tpl-render-draft-p', {
				count: warnings.length,
				warnings: warnings.map(esc).join(renderTemplate('tpl-render-draft-br')),
			})
		: renderTemplate('tpl-render-draft-p-2');
	restoreDisclosures($('#draftInfo'));
	$('#draftGrid').innerHTML = table(draft, true);
	$('#draftGrid')
		.querySelectorAll('button')
		.forEach(
			(b) =>
				(b.onclick = () => {
					let old = draft.find(
						(x) => x.user_id === b.dataset.uid && x.day === b.dataset.day,
					);
					let s = prompt(
						'Введите у, в, у/в, д или оставьте пустым для выходного:',
						old?.shift || '',
					);
					if (s === null) return;
					s = s.trim().toLowerCase();
					if (!['', 'у', 'в', 'у/в', 'д'].includes(s)) {
						notice('Неизвестное обозначение смены.');
						return;
					}
					draft = draft.filter(
						(x) => !(x.user_id === b.dataset.uid && x.day === b.dataset.day),
					);
					if (s)
						draft.push({
							user_id: b.dataset.uid,
							day: b.dataset.day,
							shift: s,
						});
					draftDirty = true;
					renderDraft();
				}),
		);
}
/* Загрузка справочников пользователей и периодов после входа. */
async function refresh() {
	profiles = check(await db.from('profiles').select('*').order('name'));
	periods = check(
		await db.from('periods').select('*').order('start_date', {
			ascending: false,
		}),
	);
	let current = $('#periodSelect').value;
	$('#periodSelect').innerHTML = periods
		.map((p) =>
			renderTemplate('tpl-refresh-option', {
				periodId: p.id,
				name: esc(p.name),
				startDate: p.start_date,
				endDate: p.end_date,
			}),
		)
		.join('');
	if (periods.some((p) => String(p.id) === current)) $('#periodSelect').value = current;
	else {
		const currentPeriod = periods.find(
			(p) => p.start_date <= bishkekToday() && p.end_date >= bishkekToday(),
		);
		if (currentPeriod) $('#periodSelect').value = currentPeriod.id;
	}
	await loadPeriod();
}
/* Загрузка версий, назначений, пожеланий и черновика выбранного периода. */
async function loadPeriod() {
	let p = period();
	syncPeriodNavigation();
	draft = [];
	draftDirty = false;
	draftExists = false;
	$('#draftGrid').innerHTML = '';
	$('#draftInfo').innerHTML = '';
	if (!p) {
		dates = [];
		prefs = [];
		assigned = [];
		versions = [];
		archiveRows = [];
		$('#versionLabel').hidden = true;
		$('#versionSelect').innerHTML = '';
		renderRequestState();
		await renderToday();
		await loadTasks();
		renderAvailability();
		$('#scheduleGrid').innerHTML = '';
		$('#mySchedule').innerHTML = renderTemplate('tpl-load-period-p');
		return;
	}
	dates = days(p);
	prefs = check(await db.from('availability').select('*').eq('period_id', p.id));
	versions = check(
		await db.from('schedule_versions').select('*').order('id', {
			ascending: false,
		}),
	);
	let allRows = check(
		await db
			.from('assignments')
			.select('*')
			.gte('day', dayAdd(p.start_date, -7))
			.lte('day', dayAdd(p.end_date, 7)),
	);
	let latest = new Map();
	versions.forEach((v) => {
		if (!latest.has(v.period_id)) latest.set(v.period_id, v.id);
	});
	assigned = allRows
		.filter((x) => [...latest.values()].includes(x.version_id))
		.map((x) => ({
			...x,
			period_id: versions.find((v) => v.id === x.version_id).period_id,
		}));
	archiveRows = allRows;
	let pv = versions.filter((v) => v.period_id === p.id);
	$('#versionLabel').hidden = me.role !== 'admin' || !pv.length;
	$('#versionSelect').innerHTML = pv
		.map((v, i) =>
			renderTemplate('tpl-load-period-option', {
				versionId: v.id,
				prefix: i === 0 ? 'Актуальная — ' : '',
				publishedAt: new Date(v.created_at).toLocaleString('ru-RU'),
			}),
		)
		.join('');
	renderAvailability();
	renderSchedule();
	renderRequestState();
	await renderToday();
	await loadTasks();
	if (me.role === 'admin') {
		let saved = check(
			await db.from('schedule_drafts').select('*').eq('period_id', p.id).maybeSingle(),
		);
		if (saved) {
			draft = saved.rows.filter((x) =>
				profiles.some((p) => p.id === x.user_id && p.role === 'staff'),
			);
			draftExists = true;
			renderDraft();
		}
	}
}
/* Права и доступность формы пожеланий по статусу сбора. */
function renderRequestState() {
	let p = period();
	$('#adminRequestStatus').textContent = !p
		? 'Выберите период.'
		: p.requests_open
			? 'Сбор заявок открыт.'
			: 'Сбор заявок закрыт.';
	$('#toggleRequests').textContent = p?.requests_open
		? 'Закрыть сбор заявок'
		: 'Открыть сбор заявок';
	$('#toggleRequests').disabled = !p;
}
$('#toggleRequests').onclick = run(async () => {
	let p = period();
	if (!p) return;
	check(
		await db
			.from('periods')
			.update({
				requests_open: !p.requests_open,
			})
			.eq('id', p.id),
	);
	p.requests_open = !p.requests_open;
	renderRequestState();
	renderAvailability();
	notice(p.requests_open ? 'Сбор заявок на смены открыт.' : 'Сбор заявок на смены закрыт.');
});

// Реализация назначается в блоке зон до запуска авторизации.
let renderToday;
/* Отображение выбранной публикации и личного календаря сотрудника. */
function renderSchedule() {
	let id = Number($('#versionSelect').value);
	let latest = versions.find((v) => v.period_id === period()?.id);
	// Админ может просматривать версии, официант видит только актуальную.
let chosen =
	me.role === 'admin'
		? versions.find((v) => v.id === id && v.period_id === period()?.id) || latest
		: latest;
	let rows = chosen ? archiveRows.filter((x) => x.version_id === chosen.id) : [];
	$('#publishedInfo').textContent = chosen
		? 'Опубликован: ' + new Date(chosen.created_at).toLocaleString('ru-RU')
		: 'График ещё не опубликован.';
	$('#scheduleGrid').innerHTML = chosen ? table(rows) : renderTemplate('tpl-render-schedule-p');
	let mine = latest
		? archiveRows
				.filter((x) => x.version_id === latest.id && x.user_id === me.id)
				.sort((a, b) => a.day.localeCompare(b.day))
		: [];
	$('#mySchedule').innerHTML = !latest
		? renderTemplate('tpl-render-schedule-p-2')
		: renderTemplate('tpl-render-schedule-div-2', {
				days: dates
					.map((d) => {
						let x = mine.find((r) => r.day === d);
						let today = bishkekToday();
						let isPast = d < today;
						let isToday = !!x && d === today;
						let next = mine.find((r) => r.day > today);
						let isNext = !!x && next?.day === d;
						let marker = isToday ? 'Сегодня' : isNext ? 'Ближайшая' : '';
						return renderTemplate('tpl-render-schedule-div', {
							hasShift: x ? 'has-shift' : '',
							isPast: isPast ? 'is-past' : '',
							isToday: isToday ? 'is-today' : '',
							isNext: isNext ? 'is-next' : '',
							dateLabel: esc(label(d)),
							shiftName: x ? esc(x.shift) : 'выходной',
							markerLabel: marker ? ', ' + marker : '',
							date: esc(label(d)),
							shift: x ? esc(x.shift.toUpperCase()) : '—',
							marker: marker
								? renderTemplate('tpl-render-schedule-span', {
										marker: marker,
									})
								: '',
						});
					})
					.join(''),
			});
}
$('#versionSelect').onchange = renderSchedule;
$('#editPublished').onclick = () => {
	if (!period()) return;
	if (
		(draftDirty || draftExists) &&
		!confirm('Заменить текущий черновик копией опубликованного графика?')
	)
		return;
	draft = assigned
		.filter(
			(x) =>
				x.period_id === period().id &&
				profiles.some((p) => p.id === x.user_id && p.role === 'staff'),
		)
		.map(({ user_id, day, shift }) => ({
			user_id,
			day,
			shift,
		}));
	if (!draft.length) {
		notice('Сначала опубликуйте график или составьте новый.');
		return;
	}
	draftDirty = true;
	renderDraft();
	notice('Актуальный график скопирован в черновик.');
};
/* Проверка конфигурации Supabase и восстановление авторизованной сессии. */
async function init() {
	if (
		!config?.url?.startsWith('https://') ||
		!config.anonKey ||
		config.anonKey.startsWith('YOUR_')
	) {
		notice('Сначала подключите Supabase: откройте инструкцию README и заполните config.js.');
		$('#loginForm button').disabled = true;
		return;
	}
	db = window.supabase.createClient(config.url, config.anonKey);
	let { data } = await db.auth.getSession();
	if (data.session) await enter(data.session.user);
}
/* Проверка профиля, переключение интерфейса по роли и загрузка данных. */
async function enter(user) {
	me = check(await db.from('profiles').select('*').eq('id', user.id).maybeSingle());
	if (!me) {
		await db.auth.signOut();
		throw Error('Заявка ещё не одобрена. Обратитесь к администратору.');
	}
	$('#login').hidden = true;
	$('#app').hidden = false;
	$('#account').textContent = me.name;
	$('#adminTab').hidden = me.role !== 'admin';
	$('#myShiftsCard').hidden = me.role !== 'staff';
	await refresh();
	if (me.role === 'admin') await loadRegistrationRequests();
}
/* Обёртка обработчиков: ошибки показываются в уведомлении и консоли. */
function run(fn) {
	return async (e) => {
		try {
			await fn(e);
		} catch (err) {
			notice('Ошибка: ' + (err.message || err));
			console.error(err);
		}
	};
}
$('#showRegister').onclick = () => {
	$('#loginForm').hidden = true;
	$('#showRegister').hidden = true;
	$('#registerForm').hidden = false;
};
$('#showLogin').onclick = () => {
	$('#registerForm').hidden = true;
	$('#loginForm').hidden = false;
	$('#showRegister').hidden = false;
};
$('#registerForm').onsubmit = run(async (e) => {
	e.preventDefault();
	let name = $('#registerName').value.trim();
	if (name.length < 2) throw Error('Введите имя и фамилию.');
	let result = await db.auth.signUp({
		email: $('#registerEmail').value.trim(),
		password: $('#registerPassword').value,
		options: {
			data: {
				name,
			},
		},
	});
	check(result);
	if (result.data.session) await db.auth.signOut();
	$('#registerPassword').value = '';
	$('#registerForm').hidden = true;
	$('#loginForm').hidden = false;
	$('#showRegister').hidden = false;
	notice(
		'Заявка отправлена. Если требуется подтверждение почты, проверьте письмо. После этого дождитесь одобрения администратора.',
	);
});
/* Заявки регистрации и действия администратора по выдаче доступа. */
async function loadRegistrationRequests() {
	if (me?.role !== 'admin') return;
	let requests = check(
		await db.from('registration_requests').select('*').order('created_at', {
			ascending: false,
		}),
	);
	$('#registrationCount').textContent = requests.length;
	let el = $('#registrationRequests');
	el.innerHTML = requests.length
		? requests
				.map((x) =>
					renderTemplate('tpl-load-registration-requests-div', {
						name: esc(x.name),
						email: esc(x.email),
						roleUserId: x.user_id,
						approveUserId: x.user_id,
					}),
				)
				.join('')
		: renderTemplate('tpl-load-registration-requests-p');
	el.querySelectorAll('[data-approve]').forEach(
		(b) =>
			(b.onclick = run(async () => {
				let role = el.querySelector(`[data-role="${b.dataset.approve}"]`).value;
				if (
					!confirm(
						role === 'admin'
							? 'Выдать этому пользователю полные права администратора?'
							: 'Одобрить заявку официанта?',
					)
				)
					return;
				b.disabled = true;
				try {
					check(
						await db.rpc('approve_registration', {
							p_user: b.dataset.approve,
							p_role: role,
						}),
					);
					await loadRegistrationRequests();
					await refresh();
					notice('Заявка одобрена.');
				} finally {
					b.disabled = false;
				}
			})),
	);
}
$('#refreshRequests').onclick = run(loadRegistrationRequests);
$('#loginForm').onsubmit = run(async (e) => {
	e.preventDefault();
	let r = await db.auth.signInWithPassword({
		email: $('#email').value,
		password: $('#password').value,
	});
	check(r);
	await enter(r.data.user);
});
$('#logout').onclick = run(async () => {
	check(await db.auth.signOut());
	location.reload();
});
$('#dashboardButton').onclick = () => {
	$('#dashboard').hidden = false;
	$('#admin').hidden = true;
	$('#dashboardButton').setAttribute('aria-pressed', 'true');
	$('#adminTab').setAttribute('aria-pressed', 'false');
};
$('#adminTab').onclick = () => {
	$('#dashboard').hidden = true;
	$('#admin').hidden = false;
	$('#dashboardButton').setAttribute('aria-pressed', 'false');
	$('#adminTab').setAttribute('aria-pressed', 'true');
	syncPeriodNavigation();
};
let selectedPeriod = '';
$('#periodSelect').addEventListener('focus', () => {
	selectedPeriod = $('#periodSelect').value;
});
$('#periodSelect').onchange = run(async () => {
	if (draftDirty && !confirm('Есть несохранённые правки черновика. Перейти без сохранения?')) {
		$('#periodSelect').value = selectedPeriod;
		syncPeriodNavigation();
		return;
	}
	await loadPeriod();
	selectedPeriod = $('#periodSelect').value;
});
window.addEventListener('beforeunload', (e) => {
	if (draftDirty) {
		e.preventDefault();
		e.returnValue = '';
	}
});
$('#saveAvailability').onclick = run(async () => {
	if (!confirm('Сохранить и отправить график? Пустые дни будут выходными.')) return;
	let rows = [];
	document.querySelectorAll('.day').forEach((el) => {
		let v = [...el.querySelectorAll('input:checked')].map((i) => i.value);
		let c = v.includes('d')
			? 'day'
			: v.includes('m') && v.includes('v')
				? 'both'
				: v.includes('m')
					? 'morning'
					: v.includes('v')
						? 'evening'
						: 'off';
		if (c)
			rows.push({
				period_id: period().id,
				user_id: me.id,
				day: el.dataset.day,
				choice: c,
			});
	});
	if (
		rows.every((x) => x.choice === 'off') &&
		!confirm('Все дни оставлены пустыми и будут отмечены выходными. Сохранить?')
	)
		return;
	let button = $('#saveAvailability');
	button.disabled = true;
	let started = Date.now();
	try {
		check(
			await db.from('availability').upsert(rows, {
				onConflict: 'period_id,user_id,day',
			}),
		);
		prefs = check(await db.from('availability').select('*').eq('period_id', period().id));
		let remaining = Math.max(0, 500 - (Date.now() - started));
		if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
		renderAvailability();
		document.querySelector('.availability-details').open = false;
		notice('Пожелания отправлены');
	} catch (err) {
		button.disabled = false;
		throw err;
	}
});
$('#periodForm').onsubmit = run(async (e) => {
	e.preventDefault();
	if (
		draftDirty &&
		!confirm('Есть несохранённые правки черновика. Создать период без сохранения?')
	)
		return;
	let a = $('#start').value,
		b = $('#end').value;
	if (b < a || b > dayAdd(a, 30)) throw Error('Период должен быть от 1 до 31 дня.');
	let overlaps = periods.some((p) => a <= p.end_date && b >= p.start_date);
	if (overlaps) throw Error('Периоды не должны пересекаться.');
	let x = check(
		await db
			.from('periods')
			.insert({
				name: $('#periodName').value.trim(),
				start_date: a,
				end_date: b,
			})
			.select()
			.single(),
	);
	await refresh();
	$('#periodSelect').value = x.id;
	await loadPeriod();
	notice('Период создан.');
});
$('#generate').onclick = run(async () => {
	if (!period()) throw Error('Сначала создайте период.');
	if ((draftDirty || draftExists) && !confirm('Заменить текущий черновик новым?')) return;
	let boundary = assigned.filter((x) => !dates.includes(x.day));
	let best = [],
		bestScore = Infinity;
	for (let attempt = 0; attempt < 80; attempt++) {
		let rows = [];
		for (let d of dates) {
			let t = target(d);
			for (let s of ['у', 'в']) {
				while (coverage(rows, d)[s === 'у' ? 'u' : 'v'] < t[s === 'у' ? 'u' : 'v']) {
					let pool = profiles
						.filter((p) => {
							const shift = choice(p.id, d) === 'both' ? 'у/в' : s;
							return (
								p.role === 'staff' &&
								eligible(p.id, d, shift, [...boundary, ...rows])
							);
						})
						.sort((a, b) => {
							let ca = rows.filter((x) => x.user_id === a.id).length;
							let cb = rows.filter((x) => x.user_id === b.id).length;
							let fa = dates.filter((day) => allows(choice(a.id, day), s)).length;
							let fb = dates.filter((day) => allows(choice(b.id, day), s)).length;
							return ca - cb || fa - fb || Math.random() - 0.5;
						});
					if (!pool.length) break;
					const shift = choice(pool[0].id, d) === 'both' ? 'у/в' : s;
					rows.push({
						user_id: pool[0].id,
						day: d,
						shift,
					});
				}
			}
			let c = coverage(rows, d);
			if (c.u < t.u || c.v < t.v) {
				let ss = c.u < t.u && c.v < t.v ? ['д', 'у/в'] : [];
				for (let s of ss) {
					while (coverage(rows, d).u < t.u && coverage(rows, d).v < t.v) {
						let p = profiles.find(
							(p) =>
								p.role === 'staff' && eligible(p.id, d, s, [...boundary, ...rows]),
						);
						if (!p) break;
						rows.push({
							user_id: p.id,
							day: d,
							shift: s,
						});
					}
				}
			}
		}
		let score =
			dates.reduce((n, d) => {
				let c = coverage(rows, d),
					t = target(d);
				return n + Math.max(0, t.u - c.u) + Math.max(0, t.v - c.v);
			}, 0) *
				100 +
			rows.filter((x) => x.shift === 'у/в').length;
		if (score < bestScore) {
			bestScore = score;
			best = rows;
		}
	}
	draft = best;
	draftDirty = true;
	renderDraft();
	notice('Черновик составлен. Проверьте его и исправьте при необходимости.');
});
$('#saveDraft').onclick = run(async () => {
	if (!period()) throw Error('Сначала выберите период.');
	check(
		await db.from('schedule_drafts').upsert(
			{
				period_id: period().id,
				rows: draft,
				updated_at: new Date().toISOString(),
			},
			{
				onConflict: 'period_id',
			},
		),
	);
	draftDirty = false;
	draftExists = true;
	notice('Черновик сохранён.');
});
let publishing = false;
let unfinishedPublication = null;
/* Проверка серверного автораспределения. Повторная попытка не создаёт публикацию. */
async function finishPublication(job) {
	const errors = [];
	for (const [stage, table, rpc] of [
		['tasks', 'task_items', 'generate_tasks_for_version'],
		['zones', 'zone_assignments', 'generate_zones_for_version'],
	]) {
		if (job[stage]) continue;
		try {
			// Триггеры базы могут уже распределить всё в транзакции публикации.
			const existing = check(
				await db.from(table).select('version_id').eq('version_id', job.version).limit(1),
			);
			if (!existing.length) check(await db.rpc(rpc, { p_version: job.version }));
			job[stage] = true;
		} catch (error) {
			errors.push(`${stage === 'tasks' ? 'Задачи' : 'Зоны'}: ${error.message}`);
		}
	}
	unfinishedPublication = errors.length ? job : null;
	$('#publicationStatus').hidden = false;
	$('#publicationMessage').textContent = errors.length
		? `График опубликован. Распределение завершено не полностью. ${errors.join(' ')}. Повторите незавершённые этапы.`
		: 'График опубликован. Автораспределение задач и зон выполнено. Назначения можно проверить в соответствующих вкладках.';
	$('#retryPublication').hidden = !errors.length;
	await loadPeriod();
	document.dispatchEvent(new Event('portal:data-changed'));
	if (!errors.length) notice('График опубликован, задачи и зоны обработаны.');
}
function lockPublication(locked) {
	publishing = locked;
	for (const id of [
		'publish',
		'generate',
		'saveDraft',
		'editPublished',
		'periodSelect',
		'adminPeriodSelect',
		'retryPublication',
	])
		$('#' + id).disabled = locked;
	document.querySelectorAll('[data-period-step]').forEach((b) => (b.disabled = locked));
	if (!locked) syncPeriodNavigation();
}
$('#publish').onclick = run(async () => {
	if (publishing) return;
	if (!period() || !draft.length) throw Error('Сначала составьте черновик.');
	const warnings = issues(draft);
	if (
		warnings.length &&
		!confirm(`Есть предупреждения (${warnings.length}). Всё равно опубликовать?`)
	)
		return;
	if (!confirm('Опубликовать график для всех сотрудников и распределить задачи и зоны?')) return;
	const p = period();
	lockPublication(true);
	try {
		check(
			await db
				.from('schedule_drafts')
				.upsert(
					{ period_id: p.id, rows: draft, updated_at: new Date().toISOString() },
					{ onConflict: 'period_id' },
				),
		);
		check(
			await db.rpc('publish_schedule', {
				p_period_id: p.id,
				p_rows: draft.map((x) => ({ user_id: x.user_id, day: x.day, shift: x.shift })),
			}),
		);
		draftDirty = false;
		draftExists = true;
		$('#publicationStatus').hidden = false;
		$('#publicationMessage').textContent = 'График опубликован. Проверяем распределение…';
		$('#retryPublication').hidden = true;
		const latest = check(
			await db
				.from('schedule_versions')
				.select('id')
				.eq('period_id', p.id)
				.order('id', { ascending: false })
				.limit(1),
		);
		if (!latest[0])
			throw Error(
				'Публикация сохранена, но её версия не загрузилась. Обновите страницу перед повторной попыткой.',
			);
		await finishPublication({ version: latest[0].id, period: p.id });
	} finally {
		lockPublication(false);
	}
});
$('#retryPublication').onclick = run(async () => {
	if (!unfinishedPublication || publishing) return;
	lockPublication(true);
	try {
		await finishPublication(unfinishedPublication);
	} finally {
		lockPublication(false);
	}
});

// При открытии пожеланий показываем начало формы
const availabilityDetails = document.querySelector('.availability-details');
availabilityDetails.addEventListener('toggle', () => {
	if (!availabilityDetails.open) return;
	requestAnimationFrame(() => {
		availabilityDetails.scrollIntoView({
			behavior: 'smooth',
			block: 'start',
		});
	});
});
/* Задачи: администратору — список и переназначение; сотруднику — чекбоксы выполнения. */
let tasksRequest = 0;
const disclosureState = new Map();
function rememberDisclosures(root) {
	root.querySelectorAll('details[data-disclosure]').forEach((el) =>
		disclosureState.set(el.dataset.disclosure, el.open),
	);
}
function restoreDisclosures(root) {
	root.querySelectorAll('details[data-disclosure]').forEach((el) => {
		if (disclosureState.has(el.dataset.disclosure))
			el.open = disclosureState.get(el.dataset.disclosure);
	});
}
/* Разделы смен → невыполненные/выполненные. Статус не дублируется в строке. */
function taskGroups(tasks, prefix, editable = false) {
	return ['morning', 'evening']
		.map((shift) => {
			const rows = tasks
				.filter((t) => t.shift === shift)
				.sort(
					(a, b) =>
						a.title.localeCompare(b.title, 'ru') ||
						String(a.id).localeCompare(String(b.id)),
				);
			const content = [false, true]
				.map((done) => {
					const matching = rows.filter((t) => Boolean(t.done) === done);
					const content =
						matching
							.map((t) => {
								const name =
									profiles.find((p) => p.id === t.user_id)?.name || 'Сотрудник';
								return editable
									? renderTemplate('tpl-task-row-label', {
											taskId: t.id,
											checked: t.done ? 'checked' : '',
											disabled: t.user_id === me.id ? '' : 'disabled',
											title: esc(t.title),
											employee:
												t.user_id === me.id
													? ''
													: renderTemplate('tpl-task-row-small', {
															employee: esc(name),
														}),
										})
									: renderTemplate('tpl-task-summary-row', {
											title: esc(t.title),
											name: esc(name),
										});
							})
							.join('') || renderTemplate('tpl-render-p-2');
					return renderTemplate('tpl-task-group', {
						key: `${prefix}-${shift}-${done ? 'done' : 'pending'}`,
						open: done ? '' : 'open',
						title: done ? 'Выполнено' : 'Не выполнено',
						count: matching.length,
						content,
					});
				})
				.join('');
			return renderTemplate('tpl-task-group', {
				key: `${prefix}-${shift}`,
				open: '',
				title: shift === 'morning' ? 'Утро' : 'Вечер',
				count: `${rows.filter((t) => t.done).length}/${rows.length}`,
				content,
			});
		})
		.join('');
}
async function loadTasks() {
	const token = ++tasksRequest;
	const card = $('#tasksCard'),
		list = $('#taskList');
	rememberDisclosures(list);
	if (!me) {
		card.hidden = true;
		list.replaceChildren();
		return;
	}
	if (me.role === 'admin') {
		const p = period();
		if (
			p &&
			(!$('#taskDate').value ||
				$('#taskDate').value < p.start_date ||
				$('#taskDate').value > p.end_date)
		)
			$('#taskDate').value =
				bishkekToday() >= p.start_date && bishkekToday() <= p.end_date
					? bishkekToday()
					: p.start_date;
		updateTaskEmployees();
		$('#adminTaskList').replaceChildren();
	}
	const today = bishkekToday();
	const p = periods.find((p) => p.start_date <= today && p.end_date >= today);
	card.hidden = false;
	if (!p) {
		list.textContent = 'На сегодня период не создан.';
		return;
	}
	const latest = check(
		await db
			.from('schedule_versions')
			.select('id')
			.eq('period_id', p.id)
			.order('id', { ascending: false })
			.limit(1),
	);
	if (token !== tasksRequest) return;
	if (!latest[0]) {
		list.textContent = 'График на сегодня ещё не опубликован.';
		return;
	}
	const [tasks, roster] = await Promise.all([
		db.from('task_items').select('*').eq('version_id', latest[0].id).eq('day', today),
		db
			.from('assignments')
			.select('user_id,shift')
			.eq('version_id', latest[0].id)
			.eq('day', today),
	]);
	const rows = check(tasks),
		crew = check(roster);
	if (token !== tasksRequest) return;
	// Запоминаем раскрытие непосредственно перед обновлением DOM, включая действия во время запроса.
	rememberDisclosures(list);
	if (me.role === 'admin') list.innerHTML = taskGroups(rows, 'admin');
	else {
		card.hidden =
			!crew.some((a) => a.user_id === me.id) && !rows.some((t) => t.user_id === me.id);
		const mine = rows.filter((t) => t.user_id === me.id),
			colleagues = rows.filter((t) => t.user_id !== me.id);
		list.innerHTML = renderTemplate('tpl-load-tasks-h3', {
			myTasks: taskGroups(mine, 'mine', true),
			colleagueCount: colleagues.length,
			colleagueTasks: taskGroups(colleagues, 'colleagues', true),
		});
		list.querySelectorAll('[data-task]:not(:disabled)').forEach(
			(el) =>
				(el.onchange = run(async () => {
					const requested = el.checked;
					el.disabled = true;
					try {
						check(
							await db.rpc('complete_task', {
								p_id: Number(el.dataset.task),
								p_done: requested,
							}),
						);
					} catch (error) {
						el.checked = !requested;
						throw error;
					} finally {
						el.disabled = false;
					}
					await loadTasks();
					notice('Задача обновлена');
				})),
		);
	}
	restoreDisclosures(list);
}
$('#taskForm').onsubmit = run(async (e) => {
	e.preventDefault();
	const v = versions.find((v) => v.period_id === period()?.id);
	const day = $('#taskDate').value,
		uid = $('#taskUser').value,
		shift = $('#taskShift').value;
	if (
		!v ||
		!assigned.some(
			(a) =>
				a.version_id === v.id &&
				a.day === day &&
				a.user_id === uid &&
				(shift === 'morning' ? ['у', 'у/в', 'д'] : ['в', 'у/в', 'д']).includes(a.shift),
		)
	)
		throw Error('У сотрудника нет выбранной смены в опубликованном графике');
	check(
		await db.from('task_items').insert({
			version_id: v.id,
			day,
			shift,
			user_id: uid,
			title: $('#taskTitle').value.trim(),
		}),
	);
	$('#taskTitle').value = '';
	await loadTasks();
	document.dispatchEvent(new Event('portal:tasks-changed'));
	notice('Задача добавлена');
});
/* Список исполнителей ручной задачи ограничен выбранной датой и сменой. */
function updateTaskEmployees() {
	const date = $('#taskDate').value;
	const shift = $('#taskShift').value;
	const select = $('#taskUser');
	const selectedUser = select.value;

	// Берём только последнюю опубликованную версию выбранного периода.
	const version = versions.find((v) => v.period_id === period()?.id);
	const matchingShifts = shift === 'morning' ? ['у', 'у/в', 'д'] : ['в', 'у/в', 'д'];
	const employees = profiles.filter(
		(person) =>
			person.role === 'staff' &&
			assigned.some(
				(assignment) =>
					assignment.version_id === version?.id &&
					assignment.user_id === person.id &&
					assignment.day === date &&
					matchingShifts.includes(assignment.shift),
			),
	);
	if (!employees.length) {
		select.innerHTML = renderTemplate('tpl-update-task-employees-option');
		return;
	}
	select.innerHTML = employees
		.map((person) =>
			renderTemplate('tpl-update-task-employees-option-2', {
				userId: esc(person.id),
				name: esc(person.name),
			}),
		)
		.join('');

	// Сохраняем выбор, если сотрудник есть и в новом списке.
	if (employees.some((person) => person.id === selectedUser)) {
		select.value = selectedUser;
	}
}
$('#taskDate').addEventListener('change', updateTaskEmployees);
$('#taskShift').addEventListener('change', updateTaskEmployees);
// Запуск распределения для уже опубликованного графика.
const taskForm = document.querySelector('#taskForm');
if (taskForm) {
	const button = document.querySelector('#generateTasks');
	button.onclick = run(async () => {
		const selected = period();
		if (!selected) {
			throw Error('Сначала выберите период.');
		}
		const version = versions.find((v) => v.period_id === selected.id);
		if (!version) {
			throw Error('Сначала опубликуйте график на выбранный период.');
		}
		button.disabled = true;
		try {
			const count = check(
				await db.rpc('generate_tasks_for_version', {
					p_version: version.id,
				}),
			);
			await loadTasks();
			document.dispatchEvent(new Event('portal:tasks-changed'));
			notice(`Распределение завершено. Добавлено задач: ${count}`);
		} finally {
			button.disabled = false;
		}
	});
}
// Справочник v2: одна запись, независимые дни утра и вечера.
(() => {
	const section = $('#admin');
	if (!section) return;
	const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
	const card = document.querySelector('#taskCatalog');
	let templates = [],
		editing = null,
		busy = false;
	const selected = (key) =>
		[...card.querySelectorAll(`input[name="${key}"]:checked`)].map((x) => Number(x.value));
	const setDays = (key, days) =>
		card
			.querySelectorAll(`input[name="${key}"]`)
			.forEach((x) => (x.checked = days.includes(Number(x.value))));
	const reset = () => {
		editing = null;
		$('#templateForm').reset();
		$('#saveTemplate').textContent = 'Добавить задачу';
		$('#cancelTemplate').hidden = false;
		$('#templateDialog').close();
		$('#templateError').hidden = true;
	};
	const describe = (days) =>
		days.length === 7
			? 'каждый день'
			: days.length
				? days.map((d) => names[d - 1]).join(', ')
				: 'нет';
	const render = () => {
		const term = $('#catalogSearch').value.trim().toLocaleLowerCase('ru');
		const rows = templates.filter((t) => t.title.toLocaleLowerCase('ru').includes(term));
		$('#catalogList').innerHTML = rows.length
			? rows
					.map((t) =>
						renderTemplate('tpl-render-div', {
							title: esc(t.title),
							morningDays: describe(t.morning_days),
							eveningDays: describe(t.evening_days),
							status: t.active ? 'Активна' : 'Отключена',
							editId: t.id,
							toggleId: t.id,
							toggleLabel: t.active ? 'Отключить' : 'Включить',
							archiveId: t.id,
						}),
					)
					.join('')
			: renderTemplate('tpl-render-p');
	};
	async function loadCatalog() {
		if (me?.role !== 'admin') return;
		const rows = [];
		for (let offset = 0; ; offset += 500) {
			const page = check(
				await db
					.from('task_templates')
					.select('id,title,morning_days,evening_days,active')
					.eq('archived', false)
					.order('title')
					.order('id')
					.range(offset, offset + 499),
			);
			rows.push(...page);
			if (page.length < 500) break;
		}
		templates = rows;
		render();
	}
	async function mutate(fn) {
		if (busy) return;
		busy = true;
		card.querySelectorAll('button').forEach((b) => (b.disabled = true));
		try {
			await fn();
			await loadCatalog();
			await loadTasks();
			document.dispatchEvent(new Event('portal:tasks-changed'));
		} catch (e) {
			if (e.code === '23505')
				throw Error('Задача с таким названием уже есть. Измените существующую.');
			throw e;
		} finally {
			busy = false;
			card.querySelectorAll('button').forEach((b) => (b.disabled = false));
		}
	}
	card.querySelectorAll('[data-all]').forEach(
		(b) => (b.onclick = () => setDays(b.dataset.all, [1, 2, 3, 4, 5, 6, 7])),
	);
	card.querySelectorAll('[data-none]').forEach(
		(b) => (b.onclick = () => setDays(b.dataset.none, [])),
	);
	$('#cancelTemplate').onclick = reset;
	$('#closeTemplateDialog').onclick = () => {
		if (!busy) reset();
	};
	$('#templateDialog').addEventListener('cancel', (e) => {
		e.preventDefault();
		if (!busy) reset();
	});
	$('#newTemplate').onclick = () => {
		reset();
		$('#templateDialogTitle').textContent = 'Новая задача';
		$('#templateDialog').showModal();
		$('#templateTitle').focus();
	};
	$('#catalogSearch').oninput = render;
	$('#refreshCatalog').onclick = run(loadCatalog);
	$('#adminTab').addEventListener('click', run(loadCatalog));
	$('#templateForm').onsubmit = async (event) => {
		try {
			event.preventDefault();
			const title = $('#templateTitle').value.trim(),
				morning_days = selected('morning_days'),
				evening_days = selected('evening_days');
			if (!title) throw Error('Введите название задачи.');
			if (!morning_days.length && !evening_days.length)
				throw Error('Выберите хотя бы один день утром или вечером.');
			const payload = {
				title,
				morning_days,
				evening_days,
			};
			await mutate(async () => {
				if (editing !== null)
					check(
						await db
							.from('task_templates')
							.update(payload)
							.eq('id', editing)
							.eq('archived', false)
							.select('id')
							.single(),
					);
				else
					check(
						await db
							.from('task_templates')
							.insert({
								...payload,
								active: true,
							})
							.select('id')
							.single(),
					);
				reset();
				notice('Задача сохранена. Для новых назначений нажмите «Распределить задачи».');
			});
		} catch (error) {
			$('#templateError').hidden = false;
			$('#templateError').textContent = error.message;
		}
	};
	$('#catalogList').onclick = run(async (event) => {
		const button = event.target.closest('button[data-action]');
		if (!button || busy) return;
		const task = templates.find((t) => String(t.id) === button.dataset.id);
		if (!task) return;
		if (button.dataset.action === 'edit') {
			editing = task.id;
			$('#templateTitle').value = task.title;
			setDays('morning_days', task.morning_days);
			setDays('evening_days', task.evening_days);
			$('#saveTemplate').textContent = 'Сохранить изменения';
			$('#cancelTemplate').hidden = false;
			$('#templateDialogTitle').textContent = 'Изменить задачу';
			$('#templateError').hidden = true;
			$('#templateDialog').showModal();
			$('#templateTitle').focus();
			return;
		}
		if (
			button.dataset.action === 'archive' &&
			!confirm(
				'Удалить задачу из справочника? Выполненные и прошедшие назначения сохранятся.',
			)
		)
			return;
		await mutate(async () => {
			if (button.dataset.action === 'archive')
				check(
					await db.rpc('archive_task_template', {
						p_id: task.id,
					}),
				);
			else
				check(
					await db
						.from('task_templates')
						.update({
							active: !task.active,
						})
						.eq('id', task.id)
						.eq('archived', false)
						.select('id')
						.single(),
				);
			if (editing === task.id) reset();
			notice(
				button.dataset.action === 'archive'
					? 'Задача удалена'
					: task.active
						? 'Задача отключена'
						: 'Задача включена. Нажмите «Распределить задачи».',
			);
		});
	});
})();
// История задач для администратора
(() => {
	const host = document.querySelector('#admin');
	const tab = document.querySelector('#adminTab');
	if (!host || !tab) return;
	const card = document.querySelector('#taskHistory');
	const el = (key) => card.querySelector(`[data-h="${key}"]`);
	const escape = (value) =>
		String(value ?? '').replace(
			/[&<>"']/g,
			(char) =>
				({
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;',
				})[char],
		);
	let rows = [];
	let request = 0;
	let version = null;
	el('date').value = bishkekToday();
	const name = (id) => profiles.find((person) => person.id === id)?.name || `Сотрудник ${id}`;
	function render() {
		if (me?.role !== 'admin') {
			rows = [];
			el('list').innerHTML = '';
			el('message').textContent = '';
			return;
		}
		const visible = rows.filter(
			(task) =>
				(!el('person').value || String(task.user_id) === el('person').value) &&
				(!el('shift').value || task.shift === el('shift').value) &&
				(!el('status').value || (el('status').value === 'done' ? task.done : !task.done)),
		);
		const completed = visible.filter((task) => task.done).length;
		const shownDate = el('date').value;
		const shownVersion = version;
		el('message').textContent =
			`По выбранным фильтрам выполнено ${completed} из ${visible.length}. ` +
			`Всего за дату: ${rows.length}. Версия №${version}.`;
		el('list').innerHTML = visible.length
			? visible
					.map((task) =>
						renderTemplate('tpl-render-div-2', {
							title: escape(task.title),
							name: escape(name(task.user_id)),
							shift: task.shift === 'morning' ? 'Утро' : 'Вечер',
							status: task.done ? '✅ Выполнено' : '⏳ Не выполнено',
							editor:
								!task.done && shownDate >= bishkekToday()
									? renderTemplate('tpl-render-button', {
											taskId: escape(task.id),
										})
									: '',
						}),
					)
					.join('')
			: renderTemplate('tpl-render-p-2');
		el('list')
			.querySelectorAll('[data-history-reassign]')
			.forEach((button) => {
				button.onclick = async () => {
					const task = visible.find(
						(item) => String(item.id) === button.dataset.historyReassign,
					);
					if (!task) return;
					const editor = button.nextElementSibling;
					button.disabled = true;
					editor.hidden = false;
					editor.textContent = 'Загружаем сотрудников…';
					try {
						const roster = check(
							await db
								.from('assignments')
								.select('user_id,shift')
								.eq('version_id', shownVersion)
								.eq('day', shownDate),
						);
						if (!button.isConnected || me?.role !== 'admin') return;
						const shifts =
							task.shift === 'morning' ? ['у', 'у/в', 'д'] : ['в', 'у/в', 'д'];
						const candidates = [
							...new Set(
								roster
									.filter(
										(item) =>
											shifts.includes(item.shift) &&
											item.user_id !== task.user_id,
									)
									.map((item) => item.user_id),
							),
						].sort((a, b) => name(a).localeCompare(name(b), 'ru'));
						if (!candidates.length) {
							editor.textContent = 'В этой смене нет другого сотрудника.';
							return;
						}
						editor.innerHTML = renderTemplate('tpl-render-label', {
							candidates: candidates
								.map((id) =>
									renderTemplate('tpl-render-option', {
										userId: escape(id),
										name: escape(name(id)),
									}),
								)
								.join(''),
						});
						const select = editor.querySelector('[data-new-assignee]');
						const save = editor.querySelector('[data-save-assignee]');
						const cancel = editor.querySelector('[data-cancel-assignee]');
						const message = editor.querySelector('[data-assignee-message]');
						cancel.onclick = () => {
							editor.hidden = true;
							editor.innerHTML = '';
						};
						save.onclick = async () => {
							const newUser = select.value;
							if (!newUser) {
								message.textContent = 'Выберите сотрудника.';
								return;
							}
							if (
								!confirm(
									`Передать задачу «${task.title}»?\n` +
										`${name(task.user_id)} → ${name(newUser)}`,
								)
							)
								return;
							save.disabled = true;
							cancel.disabled = true;
							select.disabled = true;
							message.textContent = 'Сохраняем…';
							try {
								check(
									await db.rpc('reassign_task', {
										p_task_id: task.id,
										p_version_id: shownVersion,
										p_expected_user: task.user_id,
										p_new_user: newUser,
									}),
								);
								notice('Задача переназначена');

								// Обновляем историю и главную с текущими фильтрами.
								await load();
								await loadTasks();
							} catch (error) {
								message.textContent =
									error.message || 'Не удалось переназначить задачу.';
							} finally {
								save.disabled = false;
								cancel.disabled = false;
								select.disabled = false;
							}
						};
					} catch (error) {
						editor.textContent = error.message || 'Не удалось загрузить сотрудников.';
					} finally {
						button.disabled = false;
					}
				};
			});
	}
	function populatePeriods() {
		const old = el('period').value;
		const date = el('date').value;
		const matching = periods.filter(
			(period) => period.start_date <= date && period.end_date >= date,
		);
		el('period').innerHTML = matching.length
			? matching
					.map((period) =>
						renderTemplate('tpl-populate-periods-option', {
							periodId: escape(period.id),
							name: escape(period.name),
						}),
					)
					.join('')
			: renderTemplate('tpl-populate-periods-option-2');
		if (matching.some((period) => String(period.id) === old)) {
			el('period').value = old;
		}
	}
	async function latest(periodId) {
		const data = check(
			await db
				.from('schedule_versions')
				.select('id')
				.eq('period_id', periodId)
				.order('id', {
					ascending: false,
				})
				.limit(1),
		);
		return data[0]?.id ?? null;
	}
	async function load() {
		const token = ++request;
		rows = [];
		version = null;
		el('list').innerHTML = '';
		if (me?.role !== 'admin') {
			el('message').textContent = '';
			return;
		}
		const date = el('date').value;
		const periodId = el('period').value;
		if (!date || !periodId) {
			el('message').textContent = 'Для этой даты период не создан.';
			return;
		}
		el('message').textContent = 'Загружаем задачи…';
		try {
			const selectedVersion = await latest(periodId);
			if (token !== request || me?.role !== 'admin') return;
			if (!selectedVersion) {
				el('message').textContent = 'В этом периоде ещё нет опубликованного графика.';
				return;
			}
			const fetched = [];
			for (let offset = 0; ; offset += 500) {
				const page = check(
					await db
						.from('task_items')
						.select('id,title,user_id,shift,done')
						.eq('version_id', selectedVersion)
						.eq('day', date)
						.order('id')
						.range(offset, offset + 499),
				);
				if (token !== request || me?.role !== 'admin') return;
				fetched.push(...page);
				if (page.length < 500) break;
			}

			// Проверяем, что график не перепубликовали во время загрузки.
			const current = await latest(periodId);
			if (token !== request || me?.role !== 'admin') return;
			if (current !== selectedVersion) {
				el('message').textContent =
					'График изменился во время загрузки. Нажмите «Обновить».';
				return;
			}
			rows = fetched.sort(
				(a, b) =>
					a.shift.localeCompare(b.shift) ||
					Number(a.done) - Number(b.done) ||
					a.title.localeCompare(b.title, 'ru'),
			);
			version = selectedVersion;
			const previous = el('person').value;
			const ids = [...new Set(rows.map((task) => task.user_id))].sort((a, b) =>
				name(a).localeCompare(name(b), 'ru'),
			);
			el('person').innerHTML = renderTemplate('tpl-load-option-2', {
				options: ids
					.map((id) =>
						renderTemplate('tpl-load-option', {
							userId: escape(id),
							name: escape(name(id)),
						}),
					)
					.join(''),
			});
			if (ids.some((id) => String(id) === previous)) {
				el('person').value = previous;
			}
			render();
		} catch (error) {
			if (token !== request) return;
			rows = [];
			el('list').innerHTML = '';
			el('message').textContent =
				`Не удалось загрузить историю: ${error.message || 'ошибка запроса'}`;
		}
	}
	for (const key of ['person', 'shift', 'status']) {
		el(key).addEventListener('change', () => {
			if (version !== null) render();
		});
	}
	el('date').addEventListener('change', () => {
		populatePeriods();
		void load();
	});
	el('period').addEventListener('change', () => {
		void load();
	});
	el('refresh').addEventListener('click', () => {
		populatePeriods();
		void load();
	});
	for (const event of ['portal:tasks-changed', 'portal:data-changed'])
		document.addEventListener(event, () => {
			populatePeriods();
			void load();
		});
	$('#historyAccordion').addEventListener('toggle', () => {
		if ($('#historyAccordion').open) {
			populatePeriods();
			void load();
		}
	});
	tab.addEventListener('click', () => {
		populatePeriods();
		void load();
	});
})();
// Бублик: настройки и отображение зон.
(() => {
	const admin = document.querySelector('#admin');
	const periodSelect = document.querySelector('#periodSelect');
	if (!admin || !periodSelect) return;
	const safe = (value) =>
		String(value ?? '').replace(
			/[&<>"']/g,
			(char) =>
				({
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;',
				})[char],
		);
	const card = document.querySelector('#zoneSettings');
	const label = card.querySelector('[data-z-period]');
	const terrace = card.querySelector('[data-z-terrace]');
	const switchText = card.querySelector('#terraceLabel');
	const updateSwitch = () => {
		switchText.textContent = terrace.checked ? 'Летник включён' : 'Летник выключен';
	};
	const status = card.querySelector('[data-z-status]');
	let settingsRequest = 0;
	let loadedPeriod = null;
	let saving = false;
	let todayRequest = 0;
	async function loadZoneSettings() {
		const token = ++settingsRequest;
		loadedPeriod = null;
		terrace.disabled = true;
		const selected = period();
		card.hidden = me?.role !== 'admin';
		if (card.hidden) return;
		if (!selected) {
			label.textContent = 'Сначала выберите период.';
			status.textContent = '';
			return;
		}
		label.textContent = `Период: ${selected.name}`;
		status.textContent = 'Загружаем настройку…';
		try {
			const data = check(
				await db
					.from('periods')
					.select('id,terrace_enabled')
					.eq('id', selected.id)
					.single(),
			);
			if (
				token !== settingsRequest ||
				me?.role !== 'admin' ||
				String(period()?.id) !== String(selected.id)
			)
				return;
			terrace.checked = data.terrace_enabled;
			updateSwitch();
			loadedPeriod = String(data.id);
			status.textContent = '';
			terrace.disabled = saving;
		} catch (error) {
			if (token !== settingsRequest) return;
			status.textContent = error.message || 'Не удалось загрузить настройку.';
		}
	}
	terrace.onchange = async () => {
		const selected = period();
		if (saving || me?.role !== 'admin' || !selected || loadedPeriod !== String(selected.id))
			return;
		const enabled = terrace.checked;
		updateSwitch();
		const published = versions.some((v) => v.period_id === selected.id);
		if (
			published &&
			!confirm(
				`Изменить настройку летника для «${selected.name}»? Зоны на сегодня и будущие дни будут пересчитаны, включая ручные назначения.`,
			)
		) {
			terrace.checked = !enabled;
			updateSwitch();
			return;
		}
		saving = true;
		terrace.disabled = true;
		status.textContent = 'Сохраняем настройку…';
		try {
			check(
				await db.rpc('set_period_terrace', { p_period: selected.id, p_enabled: enabled }),
			);
			selected.terrace_enabled = enabled;
			status.textContent = 'Настройка сохранена.';
			notice('Настройка летника сохранена.');
			await renderToday();
			document.dispatchEvent(new Event('portal:zones-changed'));
		} catch (error) {
			terrace.checked = !enabled;
			updateSwitch();
			notice(error.message || 'Не удалось сохранить настройку.');
		} finally {
			saving = false;
			await loadZoneSettings();
		}
	};

	// Заменяем вывод блока «Сегодня на смене».
	renderToday = async function () {
		const token = ++todayRequest;
		const today = bishkekToday();
		const content = document.querySelector('#todayContent');
		const dateLabel = document.querySelector('#todayDate');
		if (!content || !dateLabel) return;
		void loadZoneSettings();
		dateLabel.textContent = new Intl.DateTimeFormat('ru-RU', {
			timeZone: 'Asia/Bishkek',
			weekday: 'long',
			day: 'numeric',
			month: 'long',
		}).format(new Date());
		content.textContent = 'Загружаем смену и зоны…';
		const selected = periods.find((item) => item.start_date <= today && item.end_date >= today);
		if (!selected) {
			content.textContent = 'На сегодня период не создан.';
			return;
		}
		try {
			const versions = check(
				await db
					.from('schedule_versions')
					.select('id')
					.eq('period_id', selected.id)
					.order('id', {
						ascending: false,
					})
					.limit(1),
			);
			if (token !== todayRequest) return;
			const version = versions[0]?.id;
			if (!version) {
				content.textContent = 'График на сегодня ещё не опубликован.';
				return;
			}
			const results = await Promise.all([
				db
					.from('assignments')
					.select('user_id,shift')
					.eq('version_id', version)
					.eq('day', today),
				db
					.from('zone_assignments')
					.select('user_id,shift,zone_code,' + 'zone_definitions(title,tables_label)')
					.eq('version_id', version)
					.eq('day', today),
			]);
			const roster = check(results[0]);
			const zones = results[1].error ? [] : results[1].data;
			if (token !== todayRequest) return;

			// Не показываем смесь данных разных публикаций.
			const latest = check(
				await db
					.from('schedule_versions')
					.select('id')
					.eq('period_id', selected.id)
					.order('id', {
						ascending: false,
					})
					.limit(1),
			);
			if (token !== todayRequest) return;
			if (latest[0]?.id !== version) {
				content.textContent = 'График изменился. Обновите страницу.';
				return;
			}
			const personName = (id) =>
				profiles.find((person) => person.id === id)?.name || 'Сотрудник';
			const eligible = (shift) =>
				shift === 'morning' ? ['у', 'у/в', 'д'] : ['в', 'у/в', 'д'];
			function zoneText(userId, shift) {
				if (results[1].error) {
					return 'Не удалось загрузить зону';
				}
				const item = zones.find((zone) => zone.user_id === userId && zone.shift === shift);
				const definition = Array.isArray(item?.zone_definitions)
					? item.zone_definitions[0]
					: item?.zone_definitions;
				if (definition) {
					return `${definition.title} · столы ${definition.tables_label}`;
				}
				const crew = roster.filter((person) => eligible(shift).includes(person.shift));
				if (crew.length < 3 || crew.length > 6) {
					return `Зона не рассчитана: в смене ${crew.length} сотрудников`;
				}
				if (crew.filter((person) => person.shift === 'д').length > 1) {
					return 'Зона не рассчитана: в смене несколько дневников';
				}
				return 'Зона пока не назначена';
			}
			function list(shifts, taskShift) {
				const people = roster
					.filter((person) => shifts.includes(person.shift))
					.sort((a, b) =>
						personName(a.user_id).localeCompare(personName(b.user_id), 'ru'),
					);
				if (!people.length) return renderTemplate('tpl-list-p');
				return renderTemplate('tpl-list-ul', {
					employees: people
						.map((person) =>
							renderTemplate('tpl-list-li', {
								name: safe(personName(person.user_id)),
								zone: safe(zoneText(person.user_id, taskShift)),
							}),
						)
						.join(''),
				});
			}
			function fullShiftBlock(code, heading) {
				const people = roster
					.filter((person) => person.shift === code)
					.sort((a, b) =>
						personName(a.user_id).localeCompare(personName(b.user_id), 'ru'),
					);
				if (!people.length) return '';
				return renderTemplate('tpl-full-shift-block-div', {
					heading: safe(heading),
					employees: people
						.map((person) => {
							const morningRow = zones.find(
								(zone) =>
									zone.user_id === person.user_id && zone.shift === 'morning',
							);
							const eveningRow = zones.find(
								(zone) =>
									zone.user_id === person.user_id && zone.shift === 'evening',
							);
							const definition = (row) =>
								Array.isArray(row?.zone_definitions)
									? row.zone_definitions[0]
									: row?.zone_definitions;
							const morning = definition(morningRow);
							const evening = definition(eveningRow);
							let details;
							if (
								morning &&
								evening &&
								morning.tables_label === evening.tables_label
							) {
								// При разной нумерации зон показываем общий участок.
								details = safe(
									morning.title === evening.title
										? `${morning.title} · столы ${morning.tables_label}`
										: `Постоянный участок · столы ${morning.tables_label}`,
								);
							} else {
								details = renderTemplate('tpl-zone-lines', {
									morning: safe(zoneText(person.user_id, 'morning')),
									evening: safe(zoneText(person.user_id, 'evening')),
								});
							}
							return renderTemplate('tpl-full-shift-block-li', {
								name: safe(personName(person.user_id)),
								zone: details,
							});
						})
						.join(''),
				});
			}
			content.innerHTML = renderTemplate('tpl-render-today-div', {
				morning: list(['у'], 'morning'),
				evening: list(['в'], 'evening'),
				fullDay: fullShiftBlock('у/в', 'Весь день · открытие–закрытие'),
				dayShift: fullShiftBlock('д', 'День · 11:00–21:00'),
			});
		} catch (error) {
			if (token !== todayRequest) return;
			content.textContent = `Не удалось загрузить смену: ${error.message || 'ошибка'}`;
		}
	};
	document.querySelector('#adminTab')?.addEventListener('click', () => void loadZoneSettings());
	periodSelect.addEventListener('change', () => void loadZoneSettings());
	card.hidden = me?.role !== 'admin';

	// Если вход уже выполнен, обновляем блок сразу.
	if (me) void renderToday();
})();
// Бублик: ручное назначение зоны с автоматическим обменом.
(() => {
	const host = document.querySelector('#zoneSettings');
	if (!host) return;
	const box = document.querySelector('#manualZoneSwap');
	const get = (key) => box.querySelector(`[data-zone-${key}]`);
	const date = get('date');
	const shift = get('shift');
	const person = get('person');
	const target = get('target');
	const save = get('save');
	const refresh = get('refresh');
	const preview = get('preview');
	const message = get('message');
	let request = 0;
	let snapshot = null;
	let busy = false;
	date.value = bishkekToday();
	date.min = bishkekToday();
	const personName = (id) => profiles.find((item) => item.id === id)?.name || 'Сотрудник';
	function zoneName(row) {
		const definition = Array.isArray(row.zone_definitions)
			? row.zone_definitions[0]
			: row.zone_definitions;
		return definition
			? `${definition.title} · столы ${definition.tables_label}`
			: row.zone_code;
	}
	function selectedPair() {
		if (!snapshot) return null;
		const from = snapshot.rows.find((row) => row.user_id === person.value);
		const to = snapshot.rows.find((row) => row.zone_code === target.value);
		if (!from || !to || from.user_id === to.user_id) return null;
		return {
			from,
			to,
		};
	}
	function updatePreview() {
		const pair = selectedPair();
		save.disabled = busy || !pair;
		preview.textContent = pair
			? `${personName(pair.from.user_id)} получит: ` +
				`${zoneName(pair.to)}. ` +
				`${personName(pair.to.user_id)} получит: ` +
				`${zoneName(pair.from)}.`
			: '';
	}
	function populateTargets() {
		target.replaceChildren(new Option('Выберите новую зону', ''));
		const current = snapshot?.rows.find((row) => row.user_id === person.value);
		target.disabled = busy || !current;
		if (current) {
			for (const row of snapshot.rows) {
				if (row.user_id === current.user_id) continue;
				target.add(
					new Option(
						`${zoneName(row)} — сейчас ${personName(row.user_id)}`,
						row.zone_code,
					),
				);
			}
		}
		updatePreview();
	}
	async function loadZones() {
		if (busy) return;
		const token = ++request;
		snapshot = null;
		person.replaceChildren(new Option('Выберите сотрудника', ''));
		person.disabled = true;
		populateTargets();
		get('period').textContent = '';
		if (me?.role !== 'admin') {
			message.textContent = '';
			return;
		}
		date.min = bishkekToday();
		const selectedDate = date.value;
		const selectedShift = shift.value;
		if (!selectedDate || selectedDate < bishkekToday()) {
			message.textContent = 'Выберите сегодня или будущую дату.';
			return;
		}
		const selectedPeriod = periods
			.filter((p) => p.start_date <= selectedDate && p.end_date >= selectedDate)
			.sort(
				(a, b) => b.start_date.localeCompare(a.start_date) || Number(b.id) - Number(a.id),
			)[0];
		if (!selectedPeriod) {
			message.textContent = 'Для этой даты период не создан.';
			return;
		}
		get('period').textContent = `Период: ${selectedPeriod.name}`;
		message.textContent = 'Загружаем зоны…';
		try {
			const versions = check(
				await db
					.from('schedule_versions')
					.select('id')
					.eq('period_id', selectedPeriod.id)
					.order('id', {
						ascending: false,
					})
					.limit(1),
			);
			if (token !== request || me?.role !== 'admin') return;
			const version = versions[0]?.id;
			if (!version) {
				message.textContent = 'График ещё не опубликован.';
				return;
			}
			const rows = check(
				await db
					.from('zone_assignments')
					.select('user_id,zone_code,' + 'zone_definitions(title,tables_label)')
					.eq('version_id', version)
					.eq('day', selectedDate)
					.eq('shift', selectedShift),
			);
			if (token !== request || me?.role !== 'admin') return;
			rows.sort((a, b) => personName(a.user_id).localeCompare(personName(b.user_id), 'ru'));
			snapshot = {
				version,
				date: selectedDate,
				shift: selectedShift,
				rows,
			};
			for (const row of rows) {
				person.add(
					new Option(`${personName(row.user_id)} — ${zoneName(row)}`, row.user_id),
				);
			}
			person.disabled = !rows.length;
			message.textContent = rows.length
				? 'Выберите сотрудника и новую зону. ' +
					'Зона летника дневного официанта закреплена за ним.'
				: 'Зоны не назначены. Проверьте состав смены ' + 'и выполните распределение.';
			populateTargets();
		} catch (error) {
			if (token !== request) return;
			snapshot = null;
			message.textContent = error.message || 'Не удалось загрузить зоны.';
			updatePreview();
		}
	}
	save.onclick = async () => {
		if (busy || me?.role !== 'admin') return;
		const pair = selectedPair();
		if (!pair) return;
		const current = snapshot;
		const { from, to } = pair;
		if (
			!confirm(
				`Изменить зоны на ${current.date} ` +
					`(${current.shift === 'morning' ? 'утро' : 'вечер'})?\n\n` +
					`${personName(from.user_id)} → ${zoneName(to)}\n` +
					`${personName(to.user_id)} → ${zoneName(from)}`,
			)
		)
			return;
		busy = true;
		for (const control of [date, shift, person, target, refresh, save]) {
			control.disabled = true;
		}
		message.textContent = 'Сохраняем…';
		let resultMessage;
		try {
			check(
				await db.rpc('swap_employee_zones', {
					p_version: current.version,
					p_day: current.date,
					p_shift: current.shift,
					p_user_a: from.user_id,
					p_user_b: to.user_id,
					p_zone_a: from.zone_code,
					p_zone_b: to.zone_code,
				}),
			);
			resultMessage = 'Зоны изменены.';
			notice(resultMessage);
			document.dispatchEvent(new Event('portal:zones-changed'));

			// Сохранение уже завершено; обновляем главную отдельно.
			try {
				await renderToday();
			} catch {
				resultMessage += ' Обновите главную страницу.';
			}
		} catch (error) {
			resultMessage = error.message || 'Не удалось изменить зоны.';
		} finally {
			busy = false;
			date.disabled = false;
			shift.disabled = false;
			refresh.disabled = false;
			await loadZones();
			message.textContent = `${resultMessage} ${message.textContent}`;
			updatePreview();
		}
	};
	for (const event of ['portal:zones-changed', 'portal:data-changed'])
		document.addEventListener(event, () => void loadZones());
	document.addEventListener('portal:zone-date', (event) => {
		if (event.detail >= bishkekToday()) {
			date.value = event.detail;
			void loadZones();
		}
	});
	person.addEventListener('change', populateTargets);
	target.addEventListener('change', updatePreview);
	date.addEventListener('change', () => void loadZones());
	shift.addEventListener('change', () => void loadZones());
	refresh.addEventListener('click', () => void loadZones());
	document.querySelector('#adminTab')?.addEventListener('click', () => void loadZones());
	if (me?.role === 'admin') void loadZones();
})();
/* Навигация: один выбранный период для главной и админки.
 * Карточка сегодняшней смены и задач всегда относится к сегодняшней дате. */
function syncPeriodNavigation() {
	const main = $('#periodSelect'),
		admin = $('#adminPeriodSelect');
	admin.replaceChildren(...[...main.options].map((option) => option.cloneNode(true)));
	admin.value = main.value;
	selectedPeriod = main.value;
	const ordered = [...periods].sort((a, b) => a.start_date.localeCompare(b.start_date));
	const index = ordered.findIndex((p) => String(p.id) === main.value);
	document.querySelectorAll('[data-period-step]').forEach((button) => {
		button.disabled =
			publishing || index < 0 || !ordered[index + Number(button.dataset.periodStep)];
	});
}
function choosePeriod(value) {
	if (publishing) return;
	selectedPeriod = $('#periodSelect').value;
	$('#periodSelect').value = value;
	$('#periodSelect').dispatchEvent(new Event('change'));
}
$('#adminPeriodSelect').addEventListener('change', (event) => choosePeriod(event.target.value));
document.querySelectorAll('[data-period-step]').forEach((button) =>
	button.addEventListener('click', () => {
		const ordered = [...periods].sort((a, b) => a.start_date.localeCompare(b.start_date));
		const index = ordered.findIndex((p) => String(p.id) === $('#periodSelect').value);
		const next = ordered[index + Number(button.dataset.periodStep)];
		if (next) choosePeriod(String(next.id));
	}),
);
// Доступные с клавиатуры вкладки: стрелки, Home/End, обычный Tab.
function openAdminTab(name) {
	document.querySelectorAll('[data-admin-tab]').forEach((button) => {
		const active = button.dataset.adminTab === name;
		button.setAttribute('aria-selected', String(active));
		button.tabIndex = active ? 0 : -1;
		$('#panel-' + button.dataset.adminTab).hidden = !active;
	});
}
const adminTabs = [...document.querySelectorAll('[data-admin-tab]')];
adminTabs.forEach((button, index) => {
	button.onclick = () => openAdminTab(button.dataset.adminTab);
	button.onkeydown = (event) => {
		let next;
		if (event.key === 'ArrowRight') next = (index + 1) % adminTabs.length;
		if (event.key === 'ArrowLeft') next = (index + adminTabs.length - 1) % adminTabs.length;
		if (event.key === 'Home') next = 0;
		if (event.key === 'End') next = adminTabs.length - 1;
		if (next === undefined) return;
		event.preventDefault();
		adminTabs[next].click();
		adminTabs[next].focus();
	};
});

/* Календарь зон. Чтение прошлых дат не запускает перерасчёт.
 * Каждый запрос привязан к дате и последней версии; устаревшие ответы игнорируем. */
(() => {
	const input = $('#zoneViewDate'),
		calendar = $('#zoneCalendar');
	const message = $('#zoneViewStatus'),
		content = $('#zoneDayRoster');
	let month = bishkekToday().slice(0, 7),
		request = 0;
	input.value = bishkekToday();
	function renderCalendar() {
		const first = month + '-01',
			start = new Date(first + 'T12:00:00Z');
		$('#zoneMonthTitle').textContent = start.toLocaleDateString('ru-RU', {
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC',
		});
		const offset = (start.getUTCDay() + 6) % 7;
		const count = new Date(
			Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
		).getUTCDate();
		calendar.innerHTML =
			renderTemplate('tpl-zone-calendar-gap').repeat(offset) +
			Array.from({ length: count }, (_, i) => {
				const day = month + '-' + String(i + 1).padStart(2, '0');
				return renderTemplate('tpl-zone-calendar-day', {
					date: day,
					number: i + 1,
					classes: day === bishkekToday() ? 'is-today' : '',
					selected: String(day === input.value),
					label: esc(
						new Date(day + 'T12:00:00Z').toLocaleDateString('ru-RU', {
							day: 'numeric',
							month: 'long',
							year: 'numeric',
							timeZone: 'UTC',
						}),
					),
					marker: day === bishkekToday() ? 'Сегодня' : '',
				});
			}).join('');
	}
	const name = (id) => profiles.find((p) => p.id === id)?.name || 'Сотрудник';
	function zoneText(zones, id, shift) {
		const row = zones.find((z) => z.user_id === id && z.shift === shift);
		const def = Array.isArray(row?.zone_definitions)
			? row.zone_definitions[0]
			: row?.zone_definitions;
		return def ? `${def.title} · столы ${def.tables_label}` : 'Зона не назначена';
	}
	async function load() {
		const token = ++request,
			date = input.value;
		content.replaceChildren();
		if (me?.role !== 'admin' || !date) {
			message.textContent = 'Выберите дату.';
			return;
		}
		$('#zoneDateTitle').textContent = new Date(date + 'T12:00:00Z').toLocaleDateString(
			'ru-RU',
			{ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
		);
		const p = periods.find((p) => p.start_date <= date && p.end_date >= date);
		if (!p) {
			message.textContent = 'Для этой даты период не создан.';
			return;
		}
		message.textContent = 'Загружаем зоны…';
		try {
			const latest = check(
				await db
					.from('schedule_versions')
					.select('id')
					.eq('period_id', p.id)
					.order('id', { ascending: false })
					.limit(1),
			);
			if (token !== request) return;
			const version = latest[0]?.id;
			if (!version) {
				message.textContent = 'График на эту дату ещё не опубликован.';
				return;
			}
			const responses = await Promise.all([
				db
					.from('assignments')
					.select('user_id,shift')
					.eq('version_id', version)
					.eq('day', date),
				db
					.from('zone_assignments')
					.select('user_id,shift,zone_code,zone_definitions(title,tables_label)')
					.eq('version_id', version)
					.eq('day', date),
			]);
			const roster = check(responses[0]),
				zones = check(responses[1]);
			const current = check(
				await db
					.from('schedule_versions')
					.select('id')
					.eq('period_id', p.id)
					.order('id', { ascending: false })
					.limit(1),
			);
			if (token !== request) return;
			if (current[0]?.id !== version) {
				message.textContent = 'График изменился. Нажмите «Обновить».';
				return;
			}
			content.innerHTML = [
				['у', 'Утро'],
				['в', 'Вечер'],
				['у/в', 'Весь день · открытие–закрытие'],
				['д', 'День · 11:00–21:00'],
			]
				.map(([code, title]) => {
					const people = roster
						.filter((p) => p.shift === code)
						.sort((a, b) => name(a.user_id).localeCompare(name(b.user_id), 'ru'));
					if (!people.length) return '';
					return renderTemplate('tpl-zone-roster-group', {
						title,
						people: people
							.map((p) => {
								const morning = zoneText(zones, p.user_id, 'morning'),
									evening = zoneText(zones, p.user_id, 'evening');
								const full = ['д', 'у/в'].includes(code);
								const zone =
									full && morning !== evening
										? renderTemplate('tpl-zone-lines', {
												morning: esc(morning),
												evening: esc(evening),
											})
										: esc(code === 'в' ? evening : morning);
								return renderTemplate('tpl-crew-card', {
									name: esc(name(p.user_id)),
									shift: code.toUpperCase(),
									zone,
								});
							})
							.join(''),
					});
				})
				.join('');
			message.textContent = roster.length
				? `${p.name} · ${roster.length} сотрудников${!zones.length ? ' · Сохранённых назначений зон нет.' : ''}`
				: 'На эту дату смен нет.';
		} catch (error) {
			if (token === request)
				message.textContent = 'Не удалось загрузить зоны: ' + error.message;
		}
	}
	function selectDate(date) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
		input.value = date;
		month = date.slice(0, 7);
		renderCalendar();
		void load();
		document.dispatchEvent(new CustomEvent('portal:zone-date', { detail: date }));
	}
	calendar.onclick = (event) => {
		const button = event.target.closest('[data-zone-view-day]');
		if (button) selectDate(button.dataset.zoneViewDay);
	};
	input.onchange = () => selectDate(input.value);
	$('#zoneCalendarToday').onclick = () => selectDate(bishkekToday());
	$('#refreshZoneCalendar').onclick = () => void load();
	document.querySelectorAll('[data-zone-month]').forEach(
		(button) =>
			(button.onclick = () => {
				const first = new Date(month + '-01T12:00:00Z');
				first.setUTCMonth(first.getUTCMonth() + Number(button.dataset.zoneMonth));
				selectDate(first.toISOString().slice(0, 10));
			}),
	);
	$('#tab-zones').addEventListener('click', () => {
		renderCalendar();
		void load();
	});
	for (const event of ['portal:zones-changed', 'portal:data-changed'])
		document.addEventListener(event, () => void load());
	renderCalendar();
})();

// Запуск приложения после настройки всех обработчиков.
init().catch((e) => notice('Ошибка: ' + e.message));
