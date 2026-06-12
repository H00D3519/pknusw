import { useEffect, useMemo, useState } from "react";
import {
  addExpense,
  createRoom,
  deleteExpense,
  getStorageMode,
  roomExists,
  subscribeRoom,
  updatePaidTransfer,
  type Expense,
  type PaidTransfer,
  type Room,
  type StorageMode,
} from "./firebase";

type Balance = {
  member: string;
  paid: number;
  owed: number;
  balance: number;
};

type Transfer = {
  id: string;
  from: string;
  to: string;
  amount: number;
  isPaid: boolean;
};

const SHARE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EMPTY_EXPENSES: Record<string, Expense> = {};
const EMPTY_PAID_TRANSFERS: Record<string, PaidTransfer> = {};

function generateShareCode() {
  return Array.from({ length: 5 }, () => {
    const index = Math.floor(Math.random() * SHARE_CODE_CHARS.length);
    return SHARE_CODE_CHARS[index];
  }).join("");
}

async function createUniqueShareCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateShareCode();
    if (!(await roomExists(code))) {
      return code;
    }
  }

  throw new Error("공유 코드를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
}

function parseMembers(input: string) {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  );
}

function parseAmount(value: string) {
  const digitsOnly = value.replace(/[^\d]/g, "");
  return digitsOnly ? Number.parseInt(digitsOnly, 10) : 0;
}

function formatCurrency(amount: number) {
  return `${Math.abs(amount).toLocaleString("ko-KR")}원`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function getShareCodeFromPath() {
  const match = window.location.pathname.match(/^\/room\/([A-Z0-9]{5})$/i);
  return match ? match[1].toUpperCase() : "";
}

function navigateToRoom(shareCode: string) {
  window.history.pushState(null, "", `/room/${shareCode}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function calculateExpenseShares(expense: Expense) {
  const shares: Record<string, number> = {};
  const participantCount = expense.participants.length;

  if (participantCount === 0) return shares;

  const baseShare = Math.floor(expense.amount / participantCount);
  const remainder = expense.amount % participantCount;

  expense.participants.forEach((member, index) => {
    shares[member] = baseShare + (index < remainder ? 1 : 0);
  });

  return shares;
}

function calculateBalances(room: Room): Balance[] {
  const balances = room.members.map((member) => ({
    member,
    paid: 0,
    owed: 0,
    balance: 0,
  }));
  const balanceMap = new Map(balances.map((balance) => [balance.member, balance]));

  Object.values(room.expenses ?? {}).forEach((expense) => {
    const payerBalance = balanceMap.get(expense.payer);
    if (payerBalance) {
      payerBalance.paid += expense.amount;
    }

    const shares = calculateExpenseShares(expense);
    Object.entries(shares).forEach(([member, amount]) => {
      const memberBalance = balanceMap.get(member);
      if (memberBalance) {
        memberBalance.owed += amount;
      }
    });
  });

  return balances.map((balance) => ({
    ...balance,
    balance: balance.paid - balance.owed,
  }));
}

// Final transfers are calculated from total balances, not from individual expenses.
function calculateTransfers(
  balances: Balance[],
  paidTransfers: Record<string, PaidTransfer>,
): Transfer[] {
  const creditors = balances
    .filter((balance) => balance.balance > 0)
    .map((balance) => ({ member: balance.member, amount: balance.balance }))
    .sort((a, b) => b.amount - a.amount);
  const debtors = balances
    .filter((balance) => balance.balance < 0)
    .map((balance) => ({ member: balance.member, amount: Math.abs(balance.balance) }))
    .sort((a, b) => b.amount - a.amount);

  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.amount, creditor.amount);
    const id = `${debtor.member}__${creditor.member}__${amount}`;

    if (amount > 0) {
      transfers.push({
        id,
        from: debtor.member,
        to: creditor.member,
        amount,
        isPaid: Boolean(paidTransfers[id]?.isPaid),
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount === 0) debtorIndex += 1;
    if (creditor.amount === 0) creditorIndex += 1;
  }

  return transfers;
}

function getShareLabel(expense: Expense) {
  const shareValues = Object.values(calculateExpenseShares(expense));
  if (shareValues.length === 0) return "0원";

  const min = Math.min(...shareValues);
  const max = Math.max(...shareValues);

  return min === max ? formatCurrency(min) : `${formatCurrency(min)}~${formatCurrency(max)}`;
}

function getBalanceText(balance: number) {
  if (balance > 0) return `${formatCurrency(balance)} 받아야 함`;
  if (balance < 0) return `${formatCurrency(balance)} 보내야 함`;
  return "정산 완료";
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export default function App() {
  const [shareCode, setShareCode] = useState(getShareCodeFromPath);
  const [room, setRoom] = useState<Room | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>(getStorageMode());
  const [toast, setToast] = useState("");

  const [homeTitle, setHomeTitle] = useState("");
  const [homeMembers, setHomeMembers] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [homeError, setHomeError] = useState("");
  const [joinError, setJoinError] = useState("");

  const [expenseTitle, setExpenseTitle] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expensePayer, setExpensePayer] = useState("");
  const [expenseParticipants, setExpenseParticipants] = useState<string[]>([]);
  const [expenseMemo, setExpenseMemo] = useState("");
  const [expenseError, setExpenseError] = useState("");

  const expenses = useMemo(
    () => Object.values(room?.expenses ?? EMPTY_EXPENSES).sort((a, b) => b.createdAt - a.createdAt),
    [room],
  );
  const balances = useMemo(() => (room ? calculateBalances(room) : []), [room]);
  const transfers = useMemo(
    () => calculateTransfers(balances, room?.paidTransfers ?? EMPTY_PAID_TRANSFERS),
    [balances, room],
  );
  const totalExpense = useMemo(
    () => expenses.reduce((sum, expense) => sum + expense.amount, 0),
    [expenses],
  );

  useEffect(() => {
    const handlePopState = () => setShareCode(getShareCodeFromPath());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!shareCode) {
      setRoom(null);
      setIsLoading(false);
      setNotFound(false);
      return;
    }

    setIsLoading(true);
    setNotFound(false);
    setRoom(null);

    const unsubscribe = subscribeRoom(shareCode, (nextRoom) => {
      setStorageMode(getStorageMode());
      setRoom(nextRoom);
      setNotFound(!nextRoom);
      setIsLoading(false);
    });

    return unsubscribe;
  }, [shareCode]);

  useEffect(() => {
    if (!room) return;

    setExpensePayer((current) => (room.members.includes(current) ? current : room.members[0] ?? ""));
    setExpenseParticipants((current) => {
      const validCurrent = current.filter((member) => room.members.includes(member));
      return validCurrent.length > 0 ? validCurrent : room.members;
    });
  }, [room]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2500);
  }

  async function createNewRoom() {
    setHomeError("");
    const title = homeTitle.trim();
    const members = parseMembers(homeMembers);

    if (!title) {
      setHomeError("모임 이름을 입력해 주세요.");
      return;
    }

    if (members.length < 2) {
      setHomeError("참여자는 2명 이상 입력해 주세요.");
      return;
    }

    try {
      const nextShareCode = await createUniqueShareCode();
      const now = Date.now();
      const nextRoom: Room = {
        id: nextShareCode,
        shareCode: nextShareCode,
        title,
        members,
        expenses: {},
        paidTransfers: {},
        createdAt: now,
        updatedAt: now,
      };

      await createRoom(nextRoom);
      setStorageMode(getStorageMode());
      navigateToRoom(nextShareCode);
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : "정산방을 만들지 못했습니다.");
    }
  }

  async function enterRoomByCode() {
    setJoinError("");
    const nextCode = joinCode.replace(/\s/g, "").toUpperCase();
    setJoinCode(nextCode);

    if (nextCode.length !== 5) {
      setJoinError("5자리 공유 코드를 입력해 주세요.");
      return;
    }

    const exists = await roomExists(nextCode);
    setStorageMode(getStorageMode());

    if (!exists) {
      setJoinError("정산방을 찾을 수 없습니다.");
      return;
    }

    navigateToRoom(nextCode);
  }

  async function handleAddExpense() {
    if (!room) return;

    setExpenseError("");
    const title = expenseTitle.trim();
    const amount = parseAmount(expenseAmount);
    const payer = expensePayer || room.members[0];
    const participants = expenseParticipants.filter((member) => room.members.includes(member));

    if (!title) {
      setExpenseError("지출 이름을 입력해 주세요.");
      return;
    }

    if (amount <= 0) {
      setExpenseError("금액은 1원 이상 입력해 주세요.");
      return;
    }

    if (!payer) {
      setExpenseError("결제한 사람을 선택해 주세요.");
      return;
    }

    if (participants.length === 0) {
      setExpenseError("함께 사용한 사람을 1명 이상 선택해 주세요.");
      return;
    }

    const expense: Expense = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      amount,
      payer,
      participants,
      memo: expenseMemo.trim(),
      createdAt: Date.now(),
    };

    await addExpense(room.shareCode, expense);
    setStorageMode(getStorageMode());
    setExpenseTitle("");
    setExpenseAmount("");
    setExpensePayer(room.members[0] ?? "");
    setExpenseParticipants(room.members);
    setExpenseMemo("");
    showToast("지출 내역이 추가되었습니다.");
  }

  async function handleDeleteExpense(expenseId: string) {
    if (!room) return;
    await deleteExpense(room.shareCode, expenseId);
    setStorageMode(getStorageMode());
    showToast("지출 내역이 삭제되었습니다.");
  }

  async function handleTogglePaidTransfer(transfer: Transfer) {
    if (!room) return;

    await updatePaidTransfer(room.shareCode, {
      ...transfer,
      isPaid: !transfer.isPaid,
      updatedAt: Date.now(),
    });
    setStorageMode(getStorageMode());
  }

  async function handleCopyShareCode() {
    if (!room) return;
    await copyText(room.shareCode);
    showToast("공유 코드가 복사되었습니다.");
  }

  async function handleCopyShareLink() {
    await copyText(window.location.href);
    showToast("공유 링크가 복사되었습니다.");
  }

  async function handleCopyResult() {
    if (!room) return;

    const transferLines =
      transfers.length > 0
        ? transfers
            .map((transfer) => `${transfer.from} → ${transfer.to} ${formatCurrency(transfer.amount)}`)
            .join("\n")
        : "현재는 서로 주고받을 금액이 없습니다.";
    const balanceLines = balances
      .map((balance) => `${balance.member}: ${getBalanceText(balance.balance)}`)
      .join("\n");
    const expenseLines =
      expenses.length > 0
        ? expenses
            .slice()
            .reverse()
            .map(
              (expense) =>
                `${expense.title}: ${formatCurrency(expense.amount)} / ${expense.payer} 결제`,
            )
            .join("\n")
        : "입력된 지출 내역이 없습니다.";

    const resultText = `[${room.title} 정산 결과]
공유 코드: ${room.shareCode}
총 지출: ${formatCurrency(totalExpense)}
참여자: ${room.members.join(", ")}

이 정산표는 각 지출을 따로 송금하지 않고, 전체 지출을 합산한 뒤 서로 주고받을 금액을 상계해 최종 송금만 정리한 결과입니다.

최종 송금표

${transferLines}

개인별 요약

${balanceLines}

지출 내역

${expenseLines}`;

    await copyText(resultText);
    showToast("정산 결과가 복사되었습니다.");
  }

  function goHome() {
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function toggleParticipant(member: string) {
    setExpenseParticipants((current) =>
      current.includes(member)
        ? current.filter((participant) => participant !== member)
        : [...current, member],
    );
  }

  if (!shareCode) {
    return (
      <main className="page shell">
        <section className="hero">
          <p className="eyebrow">모임 정산 웹 앱</p>
          <h1>오늘 정산 끝</h1>
          <p>모임 비용을 입력하면 최종 송금표를 자동으로 계산합니다.</p>
        </section>

        <section className="home-grid" aria-label="정산방 시작">
          <article className="card">
            <h2>새 정산방 만들기</h2>
            <label className="field">
              <span>모임 이름</span>
              <input
                value={homeTitle}
                onChange={(event) => setHomeTitle(event.target.value)}
                placeholder="예: 해운대 약속"
              />
            </label>
            <label className="field">
              <span>참여자 이름</span>
              <input
                value={homeMembers}
                onChange={(event) => setHomeMembers(event.target.value)}
                placeholder="민수, 지현, 서연, 도윤"
              />
              <small>참여자는 쉼표로 구분해서 입력해 주세요.</small>
            </label>
            {homeError && <p className="error-text">{homeError}</p>}
            <button className="primary-button" type="button" onClick={createNewRoom}>
              정산방 만들기
            </button>
          </article>

          <article className="card">
            <h2>공유 코드로 입장하기</h2>
            <label className="field">
              <span>5자리 공유 코드</span>
              <input
                className="code-input"
                value={joinCode}
                maxLength={5}
                onChange={(event) =>
                  setJoinCode(event.target.value.replace(/\s/g, "").toUpperCase())
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") void enterRoomByCode();
                }}
                placeholder="A7K2P"
              />
            </label>
            {joinError && <p className="error-text">{joinError}</p>}
            <button className="secondary-button" type="button" onClick={enterRoomByCode}>
              입장
            </button>
          </article>
        </section>
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="page shell center-panel">
        <div className="card status-card">정산방을 불러오는 중입니다.</div>
      </main>
    );
  }

  if (notFound || !room) {
    return (
      <main className="page shell center-panel">
        <div className="card status-card">
          <h1>정산방을 찾을 수 없습니다.</h1>
          <p>공유 코드를 다시 확인하거나 새 정산방을 만들어 주세요.</p>
          <button className="primary-button" type="button" onClick={goHome}>
            새 정산방 만들기
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="page room-page">
      {toast && <div className="toast">{toast}</div>}

      <header className="room-header">
        <div>
          <p className="eyebrow">오늘 정산 끝</p>
          <h1>{room.title}</h1>
          <p className="muted">생성일 {formatDate(room.createdAt)}</p>
        </div>
        <div className="header-actions">
          <div className="share-code-box" aria-label={`공유 코드 ${room.shareCode}`}>
            <span>공유 코드</span>
            <strong>{room.shareCode}</strong>
          </div>
          <button type="button" onClick={handleCopyShareCode}>
            공유 코드 복사
          </button>
          <button type="button" onClick={handleCopyShareLink}>
            공유 링크 복사
          </button>
          <button type="button" onClick={goHome}>
            처음 화면
          </button>
          <span className={`mode-badge ${storageMode === "firebase" ? "firebase" : "local"}`}>
            {storageMode === "firebase" ? "Firebase 저장 모드" : "데모 저장 모드"}
          </span>
        </div>
      </header>

      <section className="summary-grid shell" aria-label="정산 요약">
        <article className="summary-card">
          <span>총 지출액</span>
          <strong>{formatCurrency(totalExpense)}</strong>
        </article>
        <article className="summary-card">
          <span>참여자 수</span>
          <strong>{room.members.length}명</strong>
        </article>
        <article className="summary-card">
          <span>지출 항목 수</span>
          <strong>{expenses.length}개</strong>
        </article>
        <article className="summary-card">
          <span>최종 송금 건수</span>
          <strong>{transfers.length}건</strong>
        </article>
      </section>

      <section className="content-grid shell">
        <article className="card expense-form-card">
          <h2>지출 추가</h2>
          <div className="form-grid">
            <label className="field">
              <span>지출 이름</span>
              <input
                value={expenseTitle}
                onChange={(event) => setExpenseTitle(event.target.value)}
                placeholder="예: 저녁 식사"
              />
            </label>
            <label className="field">
              <span>금액</span>
              <input
                inputMode="numeric"
                value={expenseAmount}
                onChange={(event) => setExpenseAmount(event.target.value)}
                placeholder="48,000"
              />
            </label>
            <label className="field">
              <span>결제한 사람</span>
              <select
                value={expensePayer}
                onChange={(event) => setExpensePayer(event.target.value)}
              >
                {room.members.map((member) => (
                  <option key={member} value={member}>
                    {member}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>메모</span>
              <input
                value={expenseMemo}
                onChange={(event) => setExpenseMemo(event.target.value)}
                placeholder="선택 입력"
              />
            </label>
          </div>

          <div className="participant-box">
            <div className="participant-header">
              <span>함께 사용한 사람</span>
              <button type="button" onClick={() => setExpenseParticipants(room.members)}>
                전체 선택
              </button>
            </div>
            <div className="checkbox-grid">
              {room.members.map((member) => (
                <label key={member} className="checkbox-pill">
                  <input
                    type="checkbox"
                    checked={expenseParticipants.includes(member)}
                    onChange={() => toggleParticipant(member)}
                  />
                  <span>{member}</span>
                </label>
              ))}
            </div>
          </div>

          {expenseError && <p className="error-text">{expenseError}</p>}
          <button className="primary-button" type="button" onClick={handleAddExpense}>
            지출 추가
          </button>
        </article>

        <article className="card transfer-card">
          <div className="section-title-row">
            <h2>최종 송금표</h2>
            <button type="button" onClick={handleCopyResult}>
              정산 결과 복사
            </button>
          </div>
          <p className="settlement-explainer">
            모든 지출을 합산하고 서로 주고받을 금액을 상계한 결과입니다. 아래 금액만
            보내면 정산이 끝납니다.
          </p>

          {transfers.length === 0 ? (
            <p className="empty-text">현재는 서로 주고받을 금액이 없습니다.</p>
          ) : (
            <div className="transfer-list">
              {transfers.map((transfer) => (
                <label
                  className={`transfer-item ${transfer.isPaid ? "paid" : ""}`}
                  key={transfer.id}
                >
                  <input
                    type="checkbox"
                    checked={transfer.isPaid}
                    onChange={() => void handleTogglePaidTransfer(transfer)}
                    aria-label={`${transfer.from}에서 ${transfer.to}에게 ${formatCurrency(
                      transfer.amount,
                    )} 송금 완료 표시`}
                  />
                  <span className="transfer-route">
                    <strong>{transfer.from}</strong>
                    <span aria-hidden="true">→</span>
                    <strong>{transfer.to}</strong>
                  </span>
                  <span className="transfer-amount">{formatCurrency(transfer.amount)}</span>
                  {transfer.isPaid && <span className="done-badge">송금 완료</span>}
                </label>
              ))}
            </div>
          )}
          <p className="notice">이 앱은 실제 송금을 처리하지 않고, 정산 금액 계산만 도와줍니다.</p>
        </article>
      </section>

      <section className="content-grid shell">
        <article className="card">
          <h2>지출 내역</h2>
          {expenses.length === 0 ? (
            <p className="empty-text">아직 입력된 지출이 없습니다.</p>
          ) : (
            <div className="expense-list">
              {expenses.map((expense) => (
                <div className="expense-card" key={expense.id}>
                  <div className="expense-topline">
                    <div>
                      <h3>{expense.title}</h3>
                      <p>
                        {formatCurrency(expense.amount)} · {expense.payer}가 결제
                      </p>
                    </div>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => void handleDeleteExpense(expense.id)}
                      aria-label={`${expense.title} 지출 삭제`}
                    >
                      삭제
                    </button>
                  </div>
                  <div className="badge-row">
                    <span className="soft-badge">결제자 {expense.payer}</span>
                    <span className="soft-badge">참여자 {expense.participants.length}명</span>
                  </div>
                  <p>참여자: {expense.participants.join(", ")}</p>
                  <p>1인 부담: {getShareLabel(expense)}</p>
                  {expense.memo && <p>메모: {expense.memo}</p>}
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="card">
          <h2>개인별 정산 요약</h2>
          <div className="balance-list">
            {balances.map((balance) => (
              <div className="balance-card" key={balance.member}>
                <div>
                  <h3>{balance.member}</h3>
                  <p>결제 {formatCurrency(balance.paid)}</p>
                  <p>부담 {formatCurrency(balance.owed)}</p>
                </div>
                <strong
                  className={
                    balance.balance > 0
                      ? "positive"
                      : balance.balance < 0
                        ? "negative"
                        : "settled"
                  }
                >
                  {getBalanceText(balance.balance)}
                </strong>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
