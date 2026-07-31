# Sign-in through the organisation's provider.
#
# What the client ends up holding is the same bearer token development sign-in
# issues, so nothing downstream changes — only how a person comes to hold one.
class SessionsController < ActionController::Base
  skip_forgery_protection

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
    render plain: handoff(user)
  end

  def failure
    render plain: "Sign-in failed.", status: :unauthorized
  end

  private

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
