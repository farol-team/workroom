# Sign-in through the organisation's provider.
#
# What the client ends up holding is the same bearer token development sign-in
# issues, so nothing downstream changes — only how a person comes to hold one.
class SessionsController < ActionController::Base
  skip_forgery_protection

  # Named here because two controllers read it and one clears it, and a cookie name
  # spelled three times is a cookie that will be spelled two ways.
  COOKIE = :workroom_token

  # A native application cannot receive a redirect the way a website can, so it
  # listens on the loopback interface and tells us where (RFC 8252). Remembered
  # before the provider is visited, because the provider brings back nothing of
  # ours.
  def start
    session[:return_port] = loopback_port(params[:return_port])
    session[:return_state] = params[:state].to_s.first(64).presence
    # Which ending this sign-in gets, recorded by the client that started it. Not
    # sniffed from a user agent afterwards: a guess about a header is a guess, and
    # the thing being guessed about is where somebody's token is handed.
    session[:return_to_web] = params[:return_to] == "web"
    redirect_to "/auth/openid_connect", allow_other_host: false
  end

  def create
    auth = request.env["omniauth.auth"]
    email = auth&.dig("info", "email").presence
    uid = auth&.dig("uid").presence
    return failure unless email && uid

    # An address the provider itself does not vouch for is not an identity —
    # Google relays whatever was typed until the person verifies it. Only an
    # explicit false refuses: providers that omit the claim have nothing to say,
    # and refusing on silence would lock out every issuer that does not send it.
    return refusal("#{email} is not a verified address with your identity provider.") if
      auth.dig("extra", "raw_info", "email_verified") == false

    user = User.find_by(email: email.downcase)
    # The provider's subject is the identity. An address that already belongs to
    # a different subject is not a sign-in — it is somebody else arriving with a
    # familiar name.
    return failure if user && user.provider == "openid_connect" && user.uid != uid

    # Signing up is not the same act as signing in (#227). Against an issuer
    # that vouches only for the organisation's own people the two coincide;
    # against a public one — accounts.google.com — whoever it vouches for would
    # become a member. So membership is decided before anything is written, and
    # a stranger the workspace has not asked for is refused, not created.
    #
    # Three ways in, tried in order: the place a person already holds; an
    # invitation naming their address; and an empty workspace, which has nobody
    # yet to do the inviting and takes its first person as its owner.
    #
    # An invitation rather than a domain allow-list, deliberately: it already
    # exists end to end, it names a person rather than everyone at a mail host,
    # it reads the same against every provider — `hd` is Google's alone — and it
    # keeps admission an act somebody took and the room recorded (`invited_by`),
    # not a config file nobody re-reads.
    invitation = Invitation.open.where("LOWER(email) = ?", email.downcase)
                           .order(:created_at).first
    way_in =
      if user&.workspace_memberships&.exists? then :membership
      elsif invitation then :invitation
      elsif WorkspaceMembership.none? then :first_person
      end
    unless way_in
      return refusal("This workspace does not admit #{email}. " \
                     "Ask somebody in it to invite you.")
    end

    user ||= User.new(email: email.downcase)
    user.assign_attributes(provider: "openid_connect", uid: uid,
                           name: auth.dig("info", "name").presence || user.name || email.split("@").first)
    user.save!

    # Signing in happens outside any room and ends inside one, so the room is
    # entered around what is recorded in it. `users` is global and needs no
    # boundary; an activity belongs to a workspace and cannot be written
    # without being in it.
    # The token names the room, so it is the membership's — there is no other
    # kind left to hand out.
    membership =
      case way_in
      when :membership   then user.workspace_memberships.order(:workspace_id).first
      when :invitation   then invitation.redeem!(user)
      when :first_person then Workspace.admit(user, role: "owner")
      end
    Workspace.entered(membership.workspace) do
      Activity.log(actor: user, action: "session.signed_in", subject: user)
    end

    port = session.delete(:return_port)
    state = session.delete(:return_state)
    return land_in_the_room(membership) if session.delete(:return_to_web)
    return render(plain: handoff(membership)) unless port

    # Only ever the loopback interface, and only ever a port this server itself
    # validated. An unvalidated return address is a way to have this server hand
    # somebody's token to a host of an attacker's choosing.
    query = { token: membership.api_token, state: state }.compact.to_query
    redirect_to "http://127.0.0.1:#{port}/?#{query}", allow_other_host: true
  end

  def failure
    render plain: "Sign-in failed.", status: :unauthorized
  end

  private

  # A browser has an address to come back to — that is what redirects are. What it
  # must not come back carrying is the token: a url is a thing that gets logged by
  # every proxy on the way, kept in history, and pasted into chat windows.
  #
  # So the token travels in a cookie script cannot read, and the page asks the
  # server for it (`GET /api/v1/auth/session`) once it has loaded. httpOnly is the
  # whole point: an injected script can make requests as this person either way, but
  # it cannot take the credential somewhere else and keep using it after the tab is
  # closed.
  def land_in_the_room(membership)
    cookies[COOKIE] = {
      value: membership.api_token,
      httponly: true,
      # Lax, not Strict: arriving here *is* a cross-site navigation — the identity
      # provider sent the browser — and Strict would refuse to send the cookie on
      # exactly the request that follows a sign-in.
      same_site: :lax,
      secure: request.ssl?,
      path: "/"
    }
    redirect_to "/", allow_other_host: false
  end

  # A different sentence from `failure`, because it is a different fact: the
  # provider vouched for this person and the workspace said no. What the person
  # can do about it is the message.
  def refusal(message)
    render plain: message, status: :forbidden
  end

  # A port a listener on this machine could actually hold. Anything else — a
  # privileged port, a hostname, a negative number, something that is not a
  # number at all — is not a return address.
  def loopback_port(raw)
    port = raw.to_s[/\A\d+\z/].to_i
    port if port.between?(1024, 65_535)
  end

  # The desktop client reads the token from this page. It is deliberately plain:
  # a browser shows it, and a loopback listener can parse it.
  def handoff(membership)
    <<~TEXT
      Signed in as #{membership.user.name} <#{membership.user.email}>.

      #{membership.api_token}

      You can close this window.
    TEXT
  end
end
