import { useEffect, useState } from 'react';
import { useHdc } from '../hdc/HdcProvider';
import { cleanTerminalText } from '../utils/format';
import { Panel } from './Panel';
import shared from '../styles/shared.module.css';
import styles from './DevicePanel.module.css';

interface ParamRow {
  label: string;
  value: string;
}

const PARAM_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['设备型号', 'param get const.product.model'],
  ['产品名称', 'param get const.product.name'],
  ['软件版本', 'param get const.product.software.version'],
  ['API 版本', 'param get const.ohos.apiversion'],
  ['CPU ABI', 'param get const.product.cpu.abilist'],
  ['构建类型', 'param get const.product.build.type'],
];

export function DevicePanel({ className }: { className?: string }) {
  const { client, device, connected } = useHdc();
  const [params, setParams] = useState<ParamRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connected) {
      setParams(null);
    }
  }, [connected]);

  const readParams = async () => {
    setLoading(true);
    const rows: ParamRow[] = [];
    try {
      for (const [label, command] of PARAM_COMMANDS) {
        let value = '—';
        try {
          const result = await client.exec(command, { timeout: 10_000 });
          const text = cleanTerminalText(result.stdout).trim();
          if (text) {
            value = text;
          }
        } catch {
          // 单个参数读取失败时保持占位
        }
        rows.push({ label, value });
        setParams([...rows]);
      }
    } finally {
      setLoading(false);
    }
  };

  const daemon = device?.daemon ?? null;
  const rows: ParamRow[] = [
    { label: '设备', value: daemon?.name || device?.productName || '—' },
    { label: '序列号', value: device?.serialNumber || '—' },
    {
      label: 'VID / PID',
      value: device ? `${device.vendorIdHex} / ${device.productIdHex}` : '—',
    },
    { label: 'HDC daemon', value: daemon?.version || '—' },
    {
      label: 'USB 接口',
      value: device?.interface
        ? `IF ${device.interface.interfaceNumber} · IN ${device.interface.inputEndpoint} / OUT ${device.interface.outputEndpoint}`
        : '—',
    },
    { label: '授权状态', value: daemon?.authStatus || '—' },
  ];

  return (
    <Panel
      kicker="DEVICE"
      title="设备信息"
      className={className}
      extra={
        <span className={`${shared.badge} ${connected ? shared.badgeOnline : ''}`.trim()}>
          {connected ? '已连接' : '未连接'}
        </span>
      }
    >
      <dl className={styles.rows}>
        {rows.map((row) => (
          <div key={row.label} className={styles.row}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {daemon && daemon.supportFeatures.length > 0 && (
        <div className={styles.features}>
          {daemon.supportFeatures.map((feature) => (
            <span key={feature} className={shared.chip}>
              {feature}
            </span>
          ))}
        </div>
      )}

      <div className={`${styles.note} ${connected ? styles.noteOk : ''}`.trim()}>
        <span aria-hidden="true">{connected ? '✓' : '!'}</span>
        {connected ? (
          <p>浏览器已独占 HDC USB 接口。</p>
        ) : (
          <p>
            若接口被占用，请先退出 DevEco Studio 或执行 <code>hdc kill</code>
            ，再点击连接。
          </p>
        )}
      </div>

      <div className={styles.params}>
        <div className={styles.paramsHeader}>
          <h3>设备参数</h3>
          <button
            className={`${shared.button} ${shared.buttonSecondary} ${styles.paramsButton}`}
            type="button"
            onClick={readParams}
            disabled={!connected || loading}
          >
            {loading ? '读取中…' : '读取设备参数'}
          </button>
        </div>
        {params ? (
          <table className={styles.paramsTable}>
            <tbody>
              {params.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className={styles.paramsHint}>
            连接后通过 <code>param get</code> 读取型号、系统与 ABI 信息。
          </p>
        )}
      </div>
    </Panel>
  );
}
