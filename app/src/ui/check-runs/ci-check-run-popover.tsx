import * as React from 'react'
import { GitHubRepository } from '../../models/github-repository'
import { IDisposable } from 'event-kit'
import { Dispatcher } from '../dispatcher'
import {
  getCheckRunConclusionAdjective,
  ICombinedRefCheck,
  IRefCheck,
} from '../../lib/stores/commit-status-store'
import { Octicon, syncClockwise } from '../octicons'
import { Button } from '../lib/button'
import { getHTMLURL } from '../../lib/api'
import { Popover, PopoverCaretPosition } from '../lib/popover'
import { CICheckRunList } from './ci-check-run-list'

interface ICICheckRunPopoverProps {
  readonly dispatcher: Dispatcher

  /** The GitHub repository to use when looking up commit status. */
  readonly repository: GitHubRepository

  /** The current branch name. */
  readonly branchName: string

  /** The pull request's number. */
  readonly prNumber: number

  /** Callback for when popover closes */
  readonly closePopover: (event?: MouseEvent) => void
}

interface ICICheckRunPopoverState {
  readonly checkRuns: ReadonlyArray<IRefCheck>
  readonly checkRunSummary: string
  readonly loadingActionLogs: boolean
  readonly loadingActionWorkflows: boolean
}

/** The CI Check Runs Popover. */
export class CICheckRunPopover extends React.PureComponent<
  ICICheckRunPopoverProps,
  ICICheckRunPopoverState
> {
  private statusSubscription: IDisposable | null = null

  public constructor(props: ICICheckRunPopoverProps) {
    super(props)

    const combinedCheck = props.dispatcher.tryGetCommitStatus(
      this.props.repository,
      this.getCommitRef(this.props.prNumber)
    )

    this.state = {
      checkRuns: combinedCheck !== null ? combinedCheck.checks : [],
      checkRunSummary: this.getCombinedCheckSummary(combinedCheck),
      loadingActionLogs: true,
      loadingActionWorkflows: true,
    }

    this.onStatus(combinedCheck)
  }

  public componentDidUpdate(prevProps: ICICheckRunPopoverProps) {
    // Re-subscribe if we're being reused to show a different status.
    if (
      this.props.repository.hash !== prevProps.repository.hash ||
      this.getCommitRef(this.props.prNumber) !==
        this.getCommitRef(prevProps.prNumber)
    ) {
      const combinedCheck = this.props.dispatcher.tryGetCommitStatus(
        this.props.repository,
        this.getCommitRef(this.props.prNumber)
      )

      this.setState({
        checkRuns: combinedCheck !== null ? combinedCheck.checks : [],
      })
      this.subscribe()
    }
  }

  public componentDidMount() {
    this.subscribe()
  }

  public componentWillUnmount() {
    this.unsubscribe()
  }

  private subscribe() {
    this.unsubscribe()

    this.statusSubscription = this.props.dispatcher.subscribeToCommitStatus(
      this.props.repository,
      this.getCommitRef(this.props.prNumber),
      this.onStatus
    )
  }

  private unsubscribe() {
    if (this.statusSubscription) {
      this.statusSubscription.dispose()
      this.statusSubscription = null
    }
  }

  private onStatus = async (check: ICombinedRefCheck | null) => {
    const statusChecks = check !== null ? check.checks : []

    if (statusChecks.length === 0) {
      this.setState({
        checkRuns: statusChecks,
        loadingActionLogs: false,
        loadingActionWorkflows: false,
      })
      return
    }

    /*
      Until we retrieve the actions workflows, we don't know if a check run has
      action logs to output, thus, we want to show loading until then. However,
      once the workflows have been retrieved and since the logs retrieval and
      parsing can be noticeably time consuming. We go ahead and flip a flag so
      that we know we can go ahead and display the checkrun `output` content if
      a check run does not have action logs to retrieve/parse.
    */
    const checkRunsWithActionsUrls = await this.props.dispatcher.getCheckRunActionsJobsAndLogURLS(
      this.props.repository,
      this.getCommitRef(this.props.prNumber),
      this.props.branchName,
      statusChecks
    )

    // When the component unmounts, this is set to null. This check will help us
    // prevent using set state on an unmounted component it it is unmounted
    // before above api returns.
    if (this.statusSubscription === null) {
      return
    }

    this.setState({
      checkRuns: checkRunsWithActionsUrls,
      loadingActionWorkflows: false,
    })

    const checkRuns = await this.props.dispatcher.getActionsWorkflowRunLogs(
      this.props.repository,
      this.getCommitRef(this.props.prNumber),
      checkRunsWithActionsUrls
    )

    // When the component unmounts, this is set to null. This check will help us
    // prevent using set state on an unmounted component it it is unmounted
    // before above api returns.
    if (this.statusSubscription === null) {
      return
    }

    this.setState({ checkRuns, loadingActionLogs: false })
  }

  private viewCheckRunsOnGitHub = (checkRun: IRefCheck): void => {
    // Some checks do not provide htmlURLS like ones for the legacy status
    // object as they do not have a view in the checks screen. In that case we
    // will just open the PR and they can navigate from there... a little
    // dissatisfying tho more of an edgecase anyways.
    const url =
      checkRun.htmlUrl ??
      `${this.props.repository.htmlURL}/pull/${this.props.prNumber}`
    if (url === null) {
      // The repository should have a htmlURL.
      return
    }
    this.props.dispatcher.openInBrowser(url)
  }

  private getCommitRef(prNumber: number): string {
    return `refs/pull/${prNumber}/head`
  }

  private getCombinedCheckSummary(
    combinedCheck: ICombinedRefCheck | null
  ): string {
    if (combinedCheck === null || combinedCheck.checks.length === 0) {
      return ''
    }

    const { checks } = combinedCheck
    const conclusionMap = new Map<string, number>()
    for (const check of checks) {
      const adj = getCheckRunConclusionAdjective(
        check.conclusion
      ).toLocaleLowerCase()
      conclusionMap.set(adj, (conclusionMap.get(adj) ?? 0) + 1)
    }

    const summaryArray = []
    for (const [conclusion, count] of conclusionMap.entries()) {
      summaryArray.push({ count, conclusion })
    }

    if (summaryArray.length > 1) {
      const output = summaryArray.map(
        ({ count, conclusion }) => `${count} ${conclusion}`
      )
      return `${output.slice(0, -1).join(', ')}, and ${output.slice(-1)} checks`
    }

    const pluralize = summaryArray[0].count > 1 ? 'checks' : 'check'
    return `${summaryArray[0].count} ${summaryArray[0].conclusion} ${pluralize}`
  }

  private rerunJobs = () => {
    // Get unique set of check suite ids
    const checkSuiteIds = new Set<number | null>([
      ...this.state.checkRuns.map(cr => cr.checkSuiteId),
    ])

    for (const id of checkSuiteIds) {
      if (id === null) {
        continue
      }
      this.props.dispatcher.rerequestCheckSuite(this.props.repository, id)
    }
  }

  private renderRerunButton = () => {
    const { checkRuns } = this.state
    return (
      <div className="ci-check-rerun">
        <Button onClick={this.rerunJobs} disabled={checkRuns.length === 0}>
          <Octicon symbol={syncClockwise} /> Re-run jobs
        </Button>
      </div>
    )
  }

  public render() {
    const {
      checkRunSummary,
      checkRuns,
      loadingActionLogs,
      loadingActionWorkflows,
    } = this.state

    const baseHref = getHTMLURL(this.props.repository.endpoint)

    return (
      <div className="ci-check-list-popover">
        <Popover
          caretPosition={PopoverCaretPosition.Top}
          onClickOutside={this.props.closePopover}
        >
          <div className="ci-check-run-list-header">
            <div className="ci-check-run-list-title-container">
              <div className="title">Checks Summary</div>
              <div className="check-run-list-summary">{checkRunSummary}</div>
            </div>
            {this.renderRerunButton()}
          </div>
          <CICheckRunList
            baseHref={baseHref}
            checkRuns={checkRuns}
            loadingActionLogs={loadingActionLogs}
            loadingActionWorkflows={loadingActionWorkflows}
            onViewOnGitHub={this.viewCheckRunsOnGitHub}
          />
        </Popover>
      </div>
    )
  }
}
