# Sign-in through the organisation's provider.
#
# What the client ends up holding is the same bearer token development sign-in
# issues, so nothing downstream changes — only how a person comes to hold one.
class SessionsController < ActionController::Base
  skip_forgery_protection

  # A native application cannot receive a redirect the way a website can, so it
  # listens on the loopback interface and tells us where (RFC 8252). Remembered
  # before the provider is visited, because the provider brings back nothing of
  # ours.
  def start
    session[:return_port] = loopback_port(params[:return_port])
    session[:return_state] = params[:state].to_s.first(64).presence
    redirect_to "/auth/openid_connect", allow_other_host: false
  end

  def create
    auth = request.env["omniauth.auth"]
    email = auth&.dig("info", "email").presence
    uid = auth&.dig("uid").presence
    return failure unless email && uid

    user = User.find_by(email: email.downcase)
    # The provider's subject is the identity. An address that already belongs to
    # a different subject is not a sign-in — it is somebody else arriving with a
    # familiar name.
    return failure if user && user.provider == "openid_connect" && user.uid != uid

    user ||= User.new(email: email.downcase)
    user.assign_attributes(provider: "openid_connect", uid: uid,
                           name: auth.dig("info", "name").presence || user.name || email.split("@").first)
    user.api_token = SecureRandom.hex(24) if user.api_token.blank?
    user.save!

    Activity.log(actor: user, action: "session.signed_in", subject: user)

    port = session.delete(:return_port)
    state = session.delete(:return_state)
    return render(plain: handoff(user)) unless port

    # Only ever the loopback interface, and only ever a port this server itself
    # validated. An unvalidated return address is a way to have this server hand
    # somebody's token to a host of an attacker's choosing.
    query = { token: user.api_token, state: state }.compact.to_query
    redirect_to "http://127.0.0.1:#{port}/?#{query}", allow_other_host: true
  end

  def failure
    render plain: "Sign-in failed.", status: :unauthorized
  end

  private

  # A port a listener on this machine could actually hold. Anything else — a
  # privileged port, a hostname, a negative number, something that is not a
  # number at all — is not a return address.
  def loopback_port(raw)
    port = raw.to_s[/\A\d+\z/].to_i
    port if port.between?(1024, 65_535)
  end

  # The desktop client reads the token from this page. It is deliberately plain:
  # a browser shows it, and a loopback listener can parse it.
  def handoff(user)
    <<~TEXT
      Signed in as #{user.name} <#{user.email}>.

      #{user.api_token}

      You can close this window.
    TEXT
  end
end
